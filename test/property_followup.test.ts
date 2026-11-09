import assert from "node:assert/strict";
import test from "node:test";
import { PropertyFollowupService } from "../src/property_followup_service.js";
import type { InfraiClient } from "../src/infrai.js";

test("schedules six hours later and captures a failed maintenance follow-up", async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const client: InfraiClient = {
    cron: {
      create: async (input) => {
        calls.push({ operation: "create", value: input });
        return { job_id: "job_42" };
      },
      delete: async (id) => calls.push({ operation: "delete", value: id }),
    },
    errors: {
      capture: async (exception) => calls.push({ operation: "capture", value: exception }),
    },
  };
  const service = new PropertyFollowupService(
    client,
    "https://property.example",
    () => new Date("2026-09-26T10:15:00.000Z"),
  );

  const scheduled = await service.schedule(
    {
      kind: "maintenance_request",
      maintenance_request_id: "maint_17",
      tenant_id: "tenant_8",
      delay_hours: 6,
    },
    "followup_9",
  );
  const finished = await service.run("followup_9", true);

  assert.equal(scheduled.runAt.toISOString(), "2026-09-26T16:15:00.000Z");
  assert.deepEqual(calls[0], {
    operation: "create",
    value: {
      cron_expr: "15 16 26 9 *",
      task: "https://property.example/callbacks/follow-ups/followup_9",
    },
  });
  assert.equal(finished.status, "failed");
  assert.equal(calls[1].operation, "capture");
  assert.deepEqual(calls[2], { operation: "delete", value: "job_42" });
});
