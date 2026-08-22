import type * as acp from "@agentclientprotocol/sdk";

/**
 * Which of a Session's extra roots are sent with it.
 *
 * `additionalDirectories` goes out only where the Agent has said it understands
 * the field: sending it to one that has not is a root the Client believes is in
 * scope and the Agent has never heard of, which is worse than sending none.
 * What is omitted is said out loud rather than dropped quietly.
 */
export function additionalDirectories(
  directories: readonly string[],
  capabilities: acp.AgentCapabilities | undefined,
  say: (text: string) => void,
): { additionalDirectories?: string[] } {
  if (directories.length === 0) return {};
  if (!capabilities?.sessionCapabilities?.additionalDirectories) {
    say(`agent does not support additionalDirectories — ${directories.length} root(s) omitted`);
    return {};
  }
  return { additionalDirectories: [...directories] };
}
