/**
 * lib/schemaUtils.ts
 *
 * Utility for generating valid PostgreSQL schema name slugs from company names.
 * Each client company gets a dedicated PostgreSQL schema named after the company.
 *
 * Example:
 *   generateSchemaName("ABC Pte Ltd")  → "abc_pte_ltd"
 *   generateSchemaName("O'Brien & Co") → "obrien_co"
 */

/**
 * Converts a company name string into a valid PostgreSQL schema name slug.
 * Rules:
 * - Lowercase only
 * - Spaces replaced with underscores
 * - Special characters stripped (only alphanumeric and underscores allowed)
 * - Leading/trailing underscores removed
 * - Consecutive underscores collapsed into one
 */
export function generateSchemaName(companyName: string): string {
  return companyName
    .toLowerCase()
    .replace(/\s+/g, "_")         // Replace whitespace with underscores
    .replace(/[^a-z0-9_]/g, "")  // Strip all non-alphanumeric, non-underscore chars
    .replace(/_+/g, "_")          // Collapse consecutive underscores
    .replace(/^_+|_+$/g, "");    // Trim leading and trailing underscores
}
