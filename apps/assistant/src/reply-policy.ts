export interface ReplyTarget {
  chatType?: string;
  conversationId: string;
  senderOpenDingTalkId?: string;
}

export interface ReplyPolicy {
  enabled: boolean;
  allowlist: string[];
}

export function shouldAutoReply(target: ReplyTarget, policy: ReplyPolicy): boolean {
  if (!policy.enabled || target.chatType !== "direct") {
    return false;
  }
  if (policy.allowlist.length === 0) {
    return false;
  }
  if (policy.allowlist.includes("all")) {
    return true;
  }
  return Boolean(
    (target.senderOpenDingTalkId && policy.allowlist.includes(target.senderOpenDingTalkId)) ||
      policy.allowlist.includes(target.conversationId),
  );
}
