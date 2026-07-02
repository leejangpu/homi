// 가계부 시트 파싱/직렬화/계산 로직 — index.html에서 서버로 포팅(동일 동작 보장).
// 근거: index.html의 parseCSV(1628), toCSV(1629), parseNum(1630),
//       splitSections(1785), calcAllTotals(3056)를 그대로 옮김.

const BOM = '﻿';

// CSV 텍스트 → 2D 배열 (index.html parseCSV 포팅, 모든 행을 최대 열수로 패딩)
function parseCSV(t) {
  if (t && t.charCodeAt(0) === 0xFEFF) t = t.slice(1); // BOM 제거
  const rows = [];
  let c = '', q = false, row = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { c += '"'; i++; }
      else if (ch === '"') q = false;
      else c += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { row.push(c); c = ''; }
      else if (ch === '\n' || (ch === '\r' && t[i + 1] === '\n')) {
        row.push(c); c = ''; rows.push(row); row = [];
        if (ch === '\r') i++;
      } else c += ch;
    }
  }
  if (c || row.length) { row.push(c); rows.push(row); }
  const mx = Math.max(...rows.map(r => r.length));
  rows.forEach(r => { while (r.length < mx) r.push(''); });
  return rows;
}

// 2D 배열 → CSV 텍스트 (index.html toCSV 포팅)
function toCSV(d) {
  return d.map(r => r.map(c => {
    const s = String(c ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

// 서버 저장 포맷(BOM 포함) — 기존 server.js /save와 동일
function toCSVFile(d) {
  return BOM + toCSV(d);
}

// 숫자 파싱 (index.html parseNum 포팅) — "=수식"은 0으로 처리(원본과 동일)
function parseNum(s) {
  if (!s) return 0;
  s = String(s).trim().replace(/[₩,\s]/g, '');
  if (!s || s === '-' || s.startsWith('#')) return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// 섹션 분석 (index.html splitSections 1785~ 포팅, 합계 재계산에 필요한 부분만).
// grid → { headerRow, monthStart, incRows, savRows, expRows, astRows }
function analyzeSections(grid) {
  const data = grid;
  let headerRow = -1, monthStart = -1;
  for (let r = 0; r < Math.min(5, data.length); r++) {
    for (let c = 3; c < data[r].length; c++) {
      const v = (data[r][c] || '').trim();
      if (/^\d{4}-\d{2}$/.test(v) || /^\d{2}\.\d{1,2}/.test(v)) { headerRow = r; monthStart = c; break; }
    }
    if (headerRow >= 0) break;
  }
  if (headerRow < 0) { headerRow = 1; monthStart = 4; }

  let mode = '', incRows = [], savRows = [], expRows = [], astRows = [];
  for (let r = 0; r < data.length; r++) {
    const c1 = (data[r][1] || '').trim(), joined = data[r].join('').trim();
    if (!joined) { mode = ''; continue; }
    if (c1.includes('급여') || c1 === '정기소득' || c1 === '비정기소득' || c1 === '순애 (90%)' || c1 === '장훈 (90%)' || c1 === '금융소득' || c1 === '배당소득' || c1 === '기타소득' || c1 === '기타') { if (mode !== 'savings' && mode !== 'expense' && mode !== 'asset') mode = 'income'; }
    if ((c1 === '저축' || (c1 === '비상금' && mode !== 'expense')) && mode !== 'asset') mode = 'savings';
    if (c1 === '지출' || c1 === '고정지출' || c1 === '변동지출' || c1 === '비정기지출') mode = 'expense';
    if (c1.includes('자산') || c1 === '부동산' || c1 === '대출' || c1 === '유동자산계') mode = 'asset';
    const isT = (c1 === '합계' || c1 === '계');
    if (mode === 'income') { incRows.push(r); if (isT) mode = ''; }
    else if (mode === 'savings') { savRows.push(r); if (isT) mode = ''; }
    else if (mode === 'expense') { expRows.push(r); }
    else if (mode === 'asset') {
      const isPercentRow = !c1 && data[r].slice(monthStart).some(v => /[▲▼]|^\d+\.\d+%$/.test(String(v || '').trim()));
      if (!isPercentRow) astRows.push(r);
    }
    else { if (c1 === '저축합계' || c1 === '지출합계') expRows.push(r); }
  }
  return { headerRow, monthStart, incRows, savRows, expRows, astRows };
}

// 합계/잔액/유동자산계/총계 재계산 (index.html calcAllTotals 3056~ 포팅). grid를 제자리 변형.
// data 셀만 사람이 입력하고, total/balance/fluid/grand 셀은 이 함수가 채운다.
function recomputeTotals(grid) {
  const raw = grid;
  const { monthStart: ms, incRows, savRows, expRows, astRows } = analyzeSections(grid);
  const numCols = raw[0] ? raw[0].length : 0;
  const sec = { income: { rows: incRows }, savings: { rows: savRows }, expense: { rows: expRows }, asset: { rows: astRows } };

  // 소득/저축: 단순 합계
  for (const key of ['income', 'savings']) {
    const s = sec[key]; if (!s || !s.rows) continue;
    let totalRow = -1;
    for (const r of s.rows) { const c1 = (raw[r][1] || '').trim(); if (c1 === '계' || c1 === '합계') totalRow = r; }
    if (totalRow < 0) continue;
    for (let c = ms; c < numCols; c++) {
      let sum = 0;
      for (const r of s.rows) { if (r === totalRow) continue; sum += parseNum(raw[r][c]); }
      raw[totalRow][c] = sum === 0 ? '0' : sum.toLocaleString('ko-KR');
    }
  }
  // 지출: 합계 + 잔액
  const exp = sec.expense;
  if (exp && exp.rows) {
    let totalRow = -1, balanceRow = -1;
    for (const r of exp.rows) { const c1 = (raw[r][1] || '').trim(); if (c1 === '계' || c1 === '합계') totalRow = r; if (c1.includes('잔액')) balanceRow = r; }
    if (totalRow >= 0) {
      for (let c = ms; c < numCols; c++) {
        let sum = 0;
        for (const r of exp.rows) { if (r === totalRow || r === balanceRow) continue; sum += parseNum(raw[r][c]); }
        raw[totalRow][c] = sum === 0 ? '0' : sum.toLocaleString('ko-KR');
      }
    }
    if (balanceRow >= 0) {
      let incTotalRow = -1, savTotalRow = -1;
      for (const r of sec.income.rows) { const c1 = (raw[r][1] || '').trim(); if (c1 === '계' || c1 === '합계') incTotalRow = r; }
      for (const r of sec.savings.rows) { const c1 = (raw[r][1] || '').trim(); if (c1 === '계' || c1 === '합계') savTotalRow = r; }
      for (let c = ms; c < numCols; c++) {
        const inc = incTotalRow >= 0 ? parseNum(raw[incTotalRow][c]) : 0;
        const sav = savTotalRow >= 0 ? parseNum(raw[savTotalRow][c]) : 0;
        const exp2 = totalRow >= 0 ? parseNum(raw[totalRow][c]) : 0;
        const bal = inc - sav - exp2;
        raw[balanceRow][c] = bal === 0 ? '0' : (bal < 0 ? '-' : '') + Math.abs(bal).toLocaleString('ko-KR');
      }
    }
  }
  // 자산: 유동자산계 + 총계
  const ast = sec.asset;
  if (ast && ast.rows) {
    const EXCL = ['부동산', '연금저축', '대출'];
    let fluidRow = -1, grandRow = -1;
    for (const r of ast.rows) { const c1 = (raw[r][1] || '').trim(); if (c1 === '유동자산계') fluidRow = r; if (c1 === '계' || c1 === '합계') grandRow = r; }
    if (fluidRow >= 0) {
      for (let c = ms; c < numCols; c++) {
        let sum = 0, lastCat = '';
        for (const r of ast.rows) {
          if (r === fluidRow || r === grandRow) continue;
          const c1 = (raw[r][1] || '').trim(); if (c1) lastCat = c1;
          if (EXCL.includes(c1 || lastCat)) continue;
          sum += parseNum(raw[r][c]);
        }
        raw[fluidRow][c] = '₩' + sum.toLocaleString('ko-KR');
      }
    }
    if (grandRow >= 0) {
      for (let c = ms; c < numCols; c++) {
        let sum = 0;
        for (const r of ast.rows) { if (r === fluidRow || r === grandRow) continue; sum += parseNum(raw[r][c]); }
        raw[grandRow][c] = '₩' + sum.toLocaleString('ko-KR');
      }
    }
  }
  return grid;
}

module.exports = { BOM, parseCSV, toCSV, toCSVFile, parseNum, analyzeSections, recomputeTotals };
