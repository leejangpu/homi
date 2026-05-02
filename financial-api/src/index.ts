export interface Env {
  GITHUB_TOKEN: string;
  SAVE_PASSWORD: string;
  REPO_OWNER: string;
  REPO_NAME: string;
}

const CORS_ORIGIN = "https://leejangpu.github.io";

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

async function handleSave(request: Request, env: Env): Promise<Response> {
  let body: { password?: string; year?: string; content?: string };

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "요청 본문을 파싱할 수 없습니다." }, 400);
  }

  const { password, year, content } = body;

  if (!password || !year || !content) {
    return jsonResponse(
      { error: "password, year, content 필드가 모두 필요합니다." },
      400
    );
  }

  if (password !== env.SAVE_PASSWORD) {
    return jsonResponse({ error: "비밀번호가 올바르지 않습니다." }, 401);
  }

  const filePath = `financial/${year}.csv`;
  const apiBase = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${filePath}`;

  const headers: HeadersInit = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "homi-financial-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };


  // 현재 파일 SHA 조회
  let sha: string | undefined;
  const getRes = await fetch(apiBase, { method: "GET", headers });

  if (getRes.ok) {
    const fileData = (await getRes.json()) as { sha?: string };
    sha = fileData.sha;
  } else if (getRes.status !== 404) {
    const errText = await getRes.text();
    return jsonResponse(
      { error: `GitHub API 조회 실패: ${errText}` },
      502
    );
  }

  // BOM + base64 인코딩
  const bom = "\uFEFF";
  const contentWithBom = bom + content;
  const encoded = btoa(unescape(encodeURIComponent(contentWithBom)));

  // 파일 업데이트 (PUT)
  const putBody: Record<string, unknown> = {
    message: `가계부 ${year} 업데이트`,
    content: encoded,
  };
  if (sha) {
    putBody.sha = sha;
  }

  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers,
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    return jsonResponse(
      { error: `GitHub API 업데이트 실패: ${errText}` },
      502
    );
  }

  // AI 리포트 자동 생성 트리거
  try {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const reportMonth = String(kst.getMonth() + 1);
    await fetch(
      `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/actions/workflows/financial-report.yml/dispatches`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: "main",
          inputs: { year, month: reportMonth },
        }),
      }
    );
  } catch (e) {
    // 리포트 생성 실패는 저장 성공에 영향을 주지 않음
  }

  return jsonResponse({ ok: true, message: `${year}.csv 저장 완료` }, 200);
}

async function githubFileRequest(
  env: Env,
  filePath: string,
  method: "GET" | "PUT",
  body?: Record<string, unknown>
): Promise<Response> {
  const headers: HeadersInit = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "homi-financial-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${filePath}`;
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function handleAnalyzeReceipt(request: Request, env: Env): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: "multipart/form-data 파싱 실패" }, 400);
  }

  const password = formData.get("password") as string | null;
  const year = formData.get("year") as string | null;
  const month = (formData.get("month") as string | null)?.padStart(2, "0");
  const file = formData.get("file") as File | null;

  if (!password || !year || !month || !file) {
    return jsonResponse({ error: "password, year, month, file 필드가 모두 필요합니다." }, 400);
  }

  if (password !== env.SAVE_PASSWORD) {
    return jsonResponse({ error: "비밀번호가 올바르지 않습니다." }, 401);
  }

  // 파일 확장자 추출
  const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
  const allowedExts = ["pdf", "jpg", "jpeg", "png", "webp"];
  if (!allowedExts.includes(ext)) {
    return jsonResponse({ error: "지원하지 않는 파일 형식입니다. (pdf/jpg/png/webp)" }, 400);
  }

  const timestamp = Date.now();
  const fileName = `receipt-${timestamp}.${ext}`;
  const filePath = `financial/tmp/${fileName}`;

  // 파일을 base64로 인코딩하여 GitHub에 업로드
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const encoded = btoa(binary);

  const putRes = await githubFileRequest(env, filePath, "PUT", {
    message: `영수증 업로드: ${year}년 ${month}월 (${fileName})`,
    content: encoded,
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    return jsonResponse({ error: `파일 업로드 실패: ${errText}` }, 502);
  }

  // GitHub Actions 워크플로우 dispatch
  const dispatchRes = await fetch(
    `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/actions/workflows/financial-receipt.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "homi-financial-api",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { year, month, file_name: fileName },
      }),
    }
  );

  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text();
    return jsonResponse({ error: `워크플로우 실행 실패: ${errText}` }, 502);
  }

  return jsonResponse({
    ok: true,
    message: `${year}년 ${month}월 영수증 분석이 시작되었습니다. 1~2분 후 가계부에 반영됩니다.`,
    fileName,
  }, 200);
}

async function handleSaveVR(request: Request, env: Env): Promise<Response> {
  let body: { content?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "요청 본문을 파싱할 수 없습니다." }, 400);
  }

  const { content } = body;
  if (!content) {
    return jsonResponse({ error: "content 필드가 필요합니다." }, 400);
  }

  const filePath = "financial/vr-state.json";
  const apiBase = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${filePath}`;
  const headers: HeadersInit = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "homi-financial-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let sha: string | undefined;
  const getRes = await fetch(apiBase, { method: "GET", headers });
  if (getRes.ok) {
    const fileData = (await getRes.json()) as { sha?: string };
    sha = fileData.sha;
  } else if (getRes.status !== 404) {
    return jsonResponse({ error: "GitHub API 조회 실패" }, 502);
  }

  const encoded = btoa(unescape(encodeURIComponent(content)));
  const putBody: Record<string, unknown> = { message: "VR 상태 저장", content: encoded };
  if (sha) putBody.sha = sha;

  const putRes = await fetch(apiBase, { method: "PUT", headers, body: JSON.stringify(putBody) });
  if (!putRes.ok) {
    const errText = await putRes.text();
    return jsonResponse({ error: `GitHub API 업데이트 실패: ${errText}` }, 502);
  }

  return jsonResponse({ ok: true, message: "vr-state.json 저장 완료" }, 200);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // OPTIONS 프리플라이트
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (url.pathname === "/save" && request.method === "POST") {
      return handleSave(request, env);
    }

    if (url.pathname === "/analyze-receipt" && request.method === "POST") {
      return handleAnalyzeReceipt(request, env);
    }

    if (url.pathname === "/save-vr" && request.method === "POST") {
      return handleSaveVR(request, env);
    }

    return jsonResponse({ error: "Not Found" }, 404);
  },
} satisfies ExportedHandler<Env>;
