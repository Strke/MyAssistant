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

const ACK_PART =
  /^(好的?|好滴|好嘞|好哒|收到(啦|了)?|谢谢(老板|老师|哥|姐)?|多谢|感谢|辛苦了?|嗯+|ok(ay)?|行|可以|明白|了解|知道了|没问题|麻烦了|thx|thanks)$/i;

export function isAcknowledgement(content: string): boolean {
  const parts = content
    .trim()
    .split(/[，,。.!！?？、\s~～]+/)
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => ACK_PART.test(part));
}
