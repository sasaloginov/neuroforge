/**
 * ReviewFindings — value object that parses and aggregates review findings with severity levels.
 */
export class ReviewFindings {
  static BLOCKING_SEVERITIES = ['CRITICAL', 'MAJOR', 'HIGH'];
  static NON_BLOCKING_SEVERITIES = ['MINOR', 'LOW'];
  static ALL_SEVERITIES = [...ReviewFindings.BLOCKING_SEVERITIES, ...ReviewFindings.NON_BLOCKING_SEVERITIES];

  #findings;
  #verdict;
  #reviewerRole;

  /**
   * @param {{ findings: Array<{severity: string, description: string}>, verdict: string|null, reviewerRole: string }} params
   */
  constructor({ findings, verdict, reviewerRole }) {
    this.#findings = Object.freeze(findings.map(f => Object.freeze({ ...f })));
    this.#verdict = verdict;
    this.#reviewerRole = reviewerRole;
  }

  get findings() { return this.#findings; }
  get verdict() { return this.#verdict; }
  get reviewerRole() { return this.#reviewerRole; }

  get blockingFindings() {
    return this.#findings.filter(f => ReviewFindings.BLOCKING_SEVERITIES.includes(f.severity));
  }

  get minorFindings() {
    return this.#findings.filter(f => ReviewFindings.NON_BLOCKING_SEVERITIES.includes(f.severity));
  }

  get hasBlockingFindings() {
    return this.blockingFindings.length > 0;
  }

  /**
   * Parse reviewer response text into ReviewFindings.
   * Supports multiple finding formats and verdict extraction.
   *
   * @param {string} responseText
   * @param {string} reviewerRole
   * @returns {ReviewFindings}
   */
  static parse(responseText, reviewerRole) {
    const severityPattern = ReviewFindings.ALL_SEVERITIES.join('|');
    const findings = [];
    const seen = new Set();

    // Pattern 1: [SEVERITY] description
    const p1 = new RegExp(`\\[(${severityPattern})\\]\\s*(.+)`, 'gi');
    // Pattern 2: **SEVERITY**: description
    const p2 = new RegExp(`\\*\\*(${severityPattern})\\*\\*[:\\s]+(.+)`, 'gi');
    // Pattern 3: SEVERITY — description  (em-dash, hyphen, or colon)
    const p3 = new RegExp(`\\b(${severityPattern})\\s*[—\\-:]\\s*(.+)`, 'gi');
    // Pattern 4: severity: SEVERITY (captures just severity, no description)
    const p4 = new RegExp(`severity[:\\s]+(${severityPattern})`, 'gi');

    for (const pattern of [p1, p2, p3]) {
      let match;
      while ((match = pattern.exec(responseText)) !== null) {
        const severity = match[1].toUpperCase();
        const description = match[2].trim();
        const key = `${severity}:${description}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ severity, description });
        }
      }
    }

    // Pattern 4: severity-only mentions (no description attached)
    {
      let match;
      while ((match = p4.exec(responseText)) !== null) {
        const severity = match[1].toUpperCase();
        // Only add if we haven't already captured findings of this severity
        if (!findings.some(f => f.severity === severity)) {
          findings.push({ severity, description: `${severity} issue identified by ${reviewerRole}` });
        }
      }
    }

    // Extract verdict
    const verdictMatch = responseText.match(/\b(PASS|FAIL)\b/i);
    const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : null;

    // Fallback: FAIL verdict with no findings → create a default MAJOR finding
    if (verdict === 'FAIL' && findings.length === 0) {
      findings.push({ severity: 'MAJOR', description: 'Review failed without specific findings' });
    }

    return new ReviewFindings({ findings, verdict, reviewerRole });
  }

  /**
   * Aggregate findings from multiple reviewer runs.
   *
   * @param {Array<{roleName: string, response: string}>} reviewerRuns — completed reviewer runs with response text
   * @returns {{ allFindings: Array, blockingFindings: Array, minorFindings: Array, reviewersWithBlockingIssues: string[], hasBlockingIssues: boolean }}
   */
  static parseAll(reviewerRuns) {
    const allFindings = [];
    const reviewersWithBlockingIssues = new Set();
    const reviewersWithIssues = new Set();

    for (const run of reviewerRuns) {
      const parsed = ReviewFindings.parse(run.response || '', run.roleName);

      for (const f of parsed.findings) {
        allFindings.push({ ...f, reviewerRole: run.roleName });
      }

      if (parsed.findings.length > 0) {
        reviewersWithIssues.add(run.roleName);
      }
      if (parsed.hasBlockingFindings) {
        reviewersWithBlockingIssues.add(run.roleName);
      }
    }

    const blockingFindings = allFindings.filter(f => ReviewFindings.BLOCKING_SEVERITIES.includes(f.severity));
    const minorFindings = allFindings.filter(f => ReviewFindings.NON_BLOCKING_SEVERITIES.includes(f.severity));

    return {
      allFindings,
      blockingFindings,
      minorFindings,
      reviewersWithBlockingIssues: [...reviewersWithBlockingIssues],
      reviewersWithIssues: [...reviewersWithIssues],
      hasBlockingIssues: blockingFindings.length > 0,
    };
  }
}
