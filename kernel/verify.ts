import type { Finding, VerificationInput, VerificationStatus, Verifier } from "./types.ts";

export interface VerificationOutcome {
  status: VerificationStatus;
  findings: Finding[];
  durationMs: number;
}

/**
 * The domain gate. Every run's proposed output passes through the service's
 * verifiers before it is allowed to become a reply; a `block` finding sends the
 * run back to the harness with the findings attached.
 */
export async function runVerification(verifiers: Verifier[], input: VerificationInput): Promise<VerificationOutcome> {
  const startedAt = Date.now();
  const findings: Finding[] = [];

  for (const verifier of verifiers) {
    try {
      findings.push(...(await verifier.run(input)));
    } catch (error) {
      findings.push({
        verifier: verifier.name,
        severity: "warn",
        code: "verifier_error",
        message: `verifier threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const status: VerificationStatus = findings.some((f) => f.severity === "block")
    ? "blocked"
    : findings.some((f) => f.severity === "warn")
      ? "warn"
      : "pass";

  return { status, findings, durationMs: Date.now() - startedAt };
}

export function finding(
  verifier: string,
  severity: Finding["severity"],
  code: string,
  message: string,
  evidence?: unknown,
): Finding {
  return evidence === undefined ? { verifier, severity, code, message } : { verifier, severity, code, message, evidence };
}
