/**
 * app/help/page.tsx
 *
 * Help & Documentation page for FinAgent-SG (Phase 6, Task 7).
 *
 * Static content — no backend calls needed.
 *
 * Sections:
 * - Getting Started
 * - Financial Statements
 * - Financial Models
 * - Payroll
 * - Training the AI (chatbot corrections)
 * - Fine-tuning
 */

import { BottomNav } from "@/components/BottomNav";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-base font-semibold mb-3 pb-1 border-b">{title}</h2>
      <div className="space-y-2 text-sm text-muted-foreground leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-medium">
        {n}
      </span>
      <p>{text}</p>
    </div>
  );
}

export default function HelpPage() {
  return (
    <div className="flex flex-col min-h-screen bg-background">
      <header className="flex items-center justify-between px-6 py-3 border-b bg-white">
        <h1 className="text-lg font-semibold tracking-tight">FinAgent-SG</h1>
      </header>

      <main className="flex-1 p-8 max-w-3xl mx-auto w-full">
        <div className="mb-8">
          <h1 className="text-xl font-semibold">Help &amp; Documentation</h1>
          <p className="text-sm text-muted-foreground mt-1">
            How to use FinAgent-SG — AI-powered financial statement preparation for Singapore companies.
          </p>
        </div>

        <Section title="Getting Started">
          <Step n={1} text="Register an account at /auth/register, then sign in." />
          <Step n={2} text="Go to Clients and click 'Add New Client' to add your first company. Fill in the company name, UEN, FYE date, and financial metrics. Audit exemption is determined automatically." />
          <Step n={3} text="Select the client from the dropdown in the main workflow panel." />
          <Step n={4} text="Choose a task: Financial Statements, Financial Model, or Payroll." />
        </Section>

        <Section title="Financial Statements">
          <Step n={1} text="Select 'Prepare Financial Statements' as the task." />
          <Step n={2} text="Upload your trial balance as an Excel file (.xlsx). The file must have columns for account code, account name, debit, and credit. Download the sample file from docs/samples/ as a reference." />
          <Step n={3} text="Confirm the FYE date, revenue, assets, and employee count in the Configure section." />
          <Step n={4} text="Click Generate. The pipeline will parse your trial balance, classify accounts per SFRS, check audit exemption, and generate all five financial statements (Balance Sheet, P&L, Cash Flow, Equity, Notes)." />
          <Step n={5} text="When generation completes, click Preview to review in the browser, Download PDF to save, or Download XBRL for the XBRL tag map." />
          <p className="pt-1 text-xs">Note: XBRL output is a JSON tag map. Full XBRL XML for ACRA BizFile+ is a future feature.</p>
        </Section>

        <Section title="Financial Models">
          <Step n={1} text="Select 'Build / Update Financial Model' as the task and choose a client." />
          <Step n={2} text="Click 'Suggest Assumptions' to get AI-powered revenue growth and expense assumptions based on your latest financial statements and Singapore economic context." />
          <Step n={3} text="Adjust assumptions if needed — revenue growth %, depreciation method (straight-line or reducing balance), tax rate, and projection years." />
          <Step n={4} text="Click Run to generate Base, Best Case, and Worst Case projections. Review the P&L and Balance Sheet tables." />
          <Step n={5} text="Click Save Model to store in the database, then Download Excel for a full 8-sheet workbook." />
          <Step n={6} text="Optionally upload an actuals Excel file to run Budget vs Actual variance analysis." />
        </Section>

        <Section title="Payroll">
          <Step n={1} text="Select 'Process Payroll' as the task and choose a client." />
          <Step n={2} text="In Step 1 (Employees), add employees with their NRIC/FIN, date of birth, citizenship status, and salary details. Citizenship determines the CPF rate table used." />
          <Step n={3} text="In Step 2 (Run Payroll), select the pay period month and click Run Payroll. CPF contributions are computed automatically per IRAS/CPF Board rules." />
          <Step n={4} text="In Step 3 (Download), download individual payslips as PDF, the CPF e-Submit CSV for CPFB portal upload, payroll journal entries, or finalise the run to lock it." />
          <p className="pt-1 text-xs">Note: FWL (Foreign Worker Levy) is flagged for manual input — rates vary by sector and DRQ. YTD OW tracking uses $0 default.</p>
        </Section>

        <Section title="Training the AI (Corrections)">
          <p>The chatbot panel on the right side of the main screen accepts two types of input:</p>
          <p><strong className="text-foreground">Corrections</strong> — messages containing keywords like &ldquo;should be&rdquo;, &ldquo;incorrect&rdquo;, &ldquo;wrong&rdquo;, &ldquo;change&rdquo;, &ldquo;update&rdquo;, or &ldquo;fix&rdquo; are saved as corrections. They are immediately added to the RAG knowledge base so the next generation reflects them. Example: <em>&ldquo;The depreciation method should be reducing balance, not straight-line.&rdquo;</em></p>
          <p><strong className="text-foreground">Questions</strong> — all other messages are answered by GPT-4.1-mini using SFRS knowledge retrieved from the RAG knowledge base. Example: <em>&ldquo;What is the small company audit exemption threshold in Singapore?&rdquo;</em></p>
          <p>Review submitted corrections at <strong className="text-foreground">/corrections</strong>. Mark corrections as &ldquo;reviewed&rdquo; to approve them for fine-tuning.</p>
        </Section>

        <Section title="Fine-tuning">
          <p>When you have accumulated 50+ reviewed corrections, you can fine-tune the model to permanently improve its outputs.</p>
          <Step n={1} text="Run: npm run export-training-data — exports reviewed corrections to docs/training/training_data.jsonl" />
          <Step n={2} text="Run: npm run fine-tune — uploads the JSONL to OpenAI and creates a fine-tuning job" />
          <Step n={3} text="When the job completes (usually 15–30 minutes), copy the model ID from the output and paste it into MODEL_ROUTES.fine_tuned_model in lib/modelRouter.ts" />
          <p className="text-xs pt-1">See docs/training/README.txt for full instructions.</p>
        </Section>
      </main>

      <BottomNav />
    </div>
  );
}
