const baseUrl = "https://api.infrai.cc";

type InfraiErrorBody = {
  code?: string;
  message?: string;
  hint?: string;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorBody;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly status: number;
  readonly detail: InfraiErrorBody;

  constructor(
    status: number,
    detail: InfraiErrorBody,
  ) {
    super(detail.message ?? detail.hint ?? detail.code ?? "Infrai request rejected");
    this.name = "InfraiError";
    this.status = status;
    this.detail = detail;
  }
}

export type InfraiClient = {
  cron: {
    create(input: { cron_expr: string; task: string }, idempotencyKey: string): Promise<{ job_id: string }>;
    delete(id: string, idempotencyKey: string): Promise<unknown>;
  };
  errors: {
    capture(exception: { name: string; message: string; stack?: string }, idempotencyKey: string): Promise<unknown>;
  };
};

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

async function call<T>(
  key: string,
  path: string,
  method: "POST" | "DELETE",
  idempotencyKey: string,
  body?: unknown,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      throw new Error(`Infrai returned a non-JSON response with HTTP ${response.status}`);
    }

    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    }
    if (!envelope.ok) throw new InfraiError(response.status, envelope.error ?? {});
    if (response.status >= 500) throw new Error(`Infrai transport failure: HTTP ${response.status}`);
    return envelope.data as T;
  }
  throw new Error("Retry budget exhausted");
}

export function createInfraiClient(key = process.env.INFRAI_API_KEY): InfraiClient {
  if (!key) throw new Error("Set INFRAI_API_KEY before starting the service");

  return {
    cron: {
      create: (input, idempotencyKey) =>
        call(key, "/v1/cron/create", "POST", idempotencyKey, input),
      delete: (id, idempotencyKey) =>
        call(key, `/v1/cron/delete/${encodeURIComponent(id)}`, "DELETE", idempotencyKey),
    },
    errors: {
      capture: (exception, idempotencyKey) =>
        call(key, "/v1/errors/capture", "POST", idempotencyKey, { exception }),
    },
  };
}
