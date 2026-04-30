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

  return jsonResponse({ ok: true, message: `${year}.csv 저장 완료` }, 200);
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

    return jsonResponse({ error: "Not Found" }, 404);
  },
} satisfies ExportedHandler<Env>;
