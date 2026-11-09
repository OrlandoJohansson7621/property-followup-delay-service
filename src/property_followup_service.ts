import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createInfraiClient, InfraiError, type InfraiClient } from "./infrai.js";

const followupSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("maintenance_request"),
    maintenance_request_id: z.string().min(1),
    tenant_id: z.string().min(1),
    delay_hours: z.number().int().min(1).max(24 * 30),
  }),
  z.object({
    kind: z.literal("tenant_document"),
    document_id: z.string().min(1),
    tenant_id: z.string().min(1),
    delay_hours: z.number().int().min(1).max(24 * 30),
  }),
  z.object({
    kind: z.literal("inspection_reminder"),
    inspection_id: z.string().min(1),
    property_id: z.string().min(1),
    delay_hours: z.number().int().min(1).max(24 * 30),
  }),
]);

const runSchema = z.object({ simulate_failure: z.boolean().optional().default(false) });
type Followup = z.infer<typeof followupSchema>;
type FollowupStatus = "scheduled" | "completed" | "failed";

type StoredFollowup = {
  id: string;
  input: Followup;
  runAt: Date;
  jobId: string;
  status: FollowupStatus;
};

export function cronAt(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}

function errorPayload(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: "UnknownError", message: String(error) };
}

export class PropertyFollowupService {
  private readonly records = new Map<string, StoredFollowup>();
  private readonly infrai: InfraiClient;
  private readonly publicUrl: string;
  private readonly now: () => Date;

  constructor(
    infrai: InfraiClient,
    publicUrl: string,
    now: () => Date = () => new Date(),
  ) {
    this.infrai = infrai;
    this.publicUrl = publicUrl;
    this.now = now;
  }

  async schedule(input: Followup, followupId: string = randomUUID()): Promise<StoredFollowup> {
    const runAt = new Date(this.now().getTime() + input.delay_hours * 3_600_000);
    const task = new URL(`/callbacks/follow-ups/${followupId}`, this.publicUrl).toString();
    const created = await this.infrai.cron.create(
      { cron_expr: cronAt(runAt), task },
      `property-followup:${followupId}:create`,
    );
    const record: StoredFollowup = {
      id: followupId,
      input,
      runAt,
      jobId: created.job_id,
      status: "scheduled",
    };
    this.records.set(followupId, record);
    return record;
  }

  async run(followupId: string, simulateFailure: boolean): Promise<StoredFollowup> {
    const record = this.records.get(followupId);
    if (!record) throw new Error("Follow-up was not found");
    if (record.status !== "scheduled") return record;

    try {
      await this.performPropertyAction(record.input, simulateFailure);
      record.status = "completed";
    } catch (error) {
      record.status = "failed";
      await this.infrai.errors.capture(
        errorPayload(error),
        `property-followup:${followupId}:failure`,
      );
    } finally {
      await this.infrai.cron.delete(record.jobId, `property-followup:${followupId}:delete`);
    }
    return record;
  }

  private async performPropertyAction(input: Followup, simulateFailure: boolean): Promise<void> {
    if (simulateFailure) throw new Error(`Could not complete ${input.kind}`);
    console.log(`Completed ${input.kind}`);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export function buildServer(service: PropertyFollowupService) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST" && url.pathname === "/follow-ups") {
        const input = followupSchema.parse(await readJson(request));
        const record = await service.schedule(input);
        send(response, 202, { id: record.id, status: record.status, run_at: record.runAt.toISOString() });
        return;
      }

      const match = url.pathname.match(/^\/callbacks\/follow-ups\/([^/]+)$/);
      if (request.method === "POST" && match) {
        const input = runSchema.parse(await readJson(request));
        const record = await service.run(decodeURIComponent(match[1]), input.simulate_failure);
        send(response, 200, { id: record.id, status: record.status });
        return;
      }
      send(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        send(response, 400, { error: "Invalid request", issues: error.issues });
      } else if (error instanceof InfraiError && error.status >= 400 && error.status < 500) {
        send(response, error.status, { error: error.message });
      } else {
        send(response, 500, { error: error instanceof Error ? error.message : "Unexpected error" });
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const publicUrl = process.env.PUBLIC_BASE_URL;
  if (!publicUrl) throw new Error("Set PUBLIC_BASE_URL to this service's public HTTPS URL");
  buildServer(new PropertyFollowupService(createInfraiClient(), publicUrl)).listen(port, () => {
    console.log(`Property follow-up service listening on http://localhost:${port}`);
  });
}
