import { DmPolicySchema, GroupPolicySchema, MarkdownConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const BlockStreamingCoalesceSchema = z.object({
  minChars: z.number().int().positive().optional(),
  idleMs: z.number().int().positive().optional(),
});

const RocketChatRoomSchema = z
  .object({
    conversationWindowMinutes: z.number().int().nonnegative().optional(),
    mediaMaxMb: z.number().positive().optional(),
  })
  .strict();

function requireOpenAllowFrom(params: {
  policy: string | undefined;
  allowFrom: Array<string | number> | undefined;
  ctx: z.RefinementCtx;
  path: string[];
  message: string;
}): void {
  if (params.policy !== "open") return;
  const list = params.allowFrom ?? [];
  const hasWildcard = list.some((e) => String(e).trim() === "*");
  if (!hasWildcard) {
    params.ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: params.message,
      path: params.path,
    });
  }
}

const RocketChatAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    authToken: z.string().optional(),
    userId: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    baseUrl: z.string().optional(),
    chatmode: z.enum(["oncall", "onmessage", "onchar"]).optional(),
    oncharPrefixes: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    conversationWindowMinutes: z.number().int().nonnegative().optional(),
    mediaMaxMb: z.number().positive().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
    rooms: z.record(z.string(), RocketChatRoomSchema).optional(),
  })
  .strict();

const RocketChatAccountSchema = RocketChatAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.rocketchat.dmPolicy="open" requires channels.rocketchat.allowFrom to include "*"',
  });
});

export const RocketChatConfigSchema = RocketChatAccountSchemaBase.extend({
  accounts: z.record(z.string(), RocketChatAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.rocketchat.dmPolicy="open" requires channels.rocketchat.allowFrom to include "*"',
  });
});
