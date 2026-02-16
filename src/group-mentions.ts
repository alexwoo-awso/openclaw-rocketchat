import type { ChannelGroupContext } from "openclaw/plugin-sdk";
import { resolveRocketChatAccount } from "./rocketchat/accounts.js";

export function resolveRocketChatGroupRequireMention(
  params: ChannelGroupContext,
): boolean | undefined {
  const account = resolveRocketChatAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (typeof account.requireMention === "boolean") {
    return account.requireMention;
  }
  return true;
}
