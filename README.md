# FinAgent-SG

FinAgent-SG is an AI-powered accounting assistant for Singapore private limited companies. It automates the preparation of SFRS-compliant financial statements, financial projections, and payroll processing — reducing manual effort and the risk of errors. Built for accountants and finance professionals who manage Singapore-incorporated entities.

---

## Use Cases

- **Financial Statement Preparation** — Upload a trial balance and receive a complete set of SFRS-compliant financial statements as a downloadable PDF.
- **Financial Model Builder** — Generate multi-year financial projections with base, best-case, and worst-case scenarios, and compare them against actual results.
- **Payroll & CPF Processing** — Run monthly payroll, compute CPF contributions, generate MOM-compliant payslips, and export the CPF e-Submit file.

---

## How It Works

1. Register an account and add your client company to the system.
2. Upload the client's trial balance as an Excel file.
3. The AI reviews the accounts, applies Singapore Financial Reporting Standards, and generates a full set of financial statements.
4. Review the output in the browser and download the PDF.
5. If anything looks incorrect, submit a correction through the integrated chatbot.
6. Corrections are reviewed and used to improve future generations for that client.

---

## Tech Stack

| Tool | Purpose |
|------|---------|
| Next.js 15 | Full-stack web framework (App Router) |
| Vercel AI SDK 6 | Streaming AI responses and tool integration |
| OpenAI | Language model for financial statement generation and analysis |
| Supabase | Multi-tenant PostgreSQL database and authentication backend |
| ChromaDB | Local vector store for RAG during development |
| pgvector | Production vector store hosted within Supabase |
| Langfuse | LLM observability, tracing, and cost tracking |
| Trigger.dev | Background job processing for long-running tasks |
| NextAuth.js | Email and password authentication |
| Zod | Runtime data validation across all API boundaries |
| bignumber.js | Precise financial arithmetic without floating-point errors |
| exceljs | Excel file parsing and workbook export |
| pdfkit | PDF generation for financial statements and payslips |
| Docker | Local infrastructure for ChromaDB and Langfuse |

---

## Prerequisites

- Node.js 18+
- Docker Desktop
- A Supabase account
- An OpenAI account with API key

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the values:

```
OPENAI_API_KEY
NEXTAUTH_SECRET
NEXTAUTH_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
CHROMA_URL
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
LANGFUSE_HOST
```

---

## Getting Started

1. Clone the repository and run `npm install` to install dependencies.
2. Copy `.env.example` to `.env.local` and fill in all required values.
3. Open the Supabase SQL editor and run `supabase/schema.sql` to create all tables.
4. Start Docker services with `docker compose --env-file docker-compose.env up -d`.
5. Start the development server with `npm run dev`.
6. Register an account at [http://localhost:3000](http://localhost:3000).

---

## Project Structure

| Folder | Description |
|--------|-------------|
| `app/` | Next.js pages and API routes |
| `components/` | Reusable UI components |
| `lib/` | Core business logic and utility modules |
| `scripts/` | CLI scripts for data ingestion and maintenance |
| `supabase/` | Database schema SQL |
| `trigger/` | Background job definitions |
| `skills/` | Domain knowledge files for Singapore accounting and payroll rules |
| `docs/` | Reference documents, sample files, and training data |
| `public/` | Static assets |

---

## License

This project is proprietary. All rights reserved.
