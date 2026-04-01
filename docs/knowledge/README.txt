FinAgent-SG — RAG Knowledge Base
=================================

Place source documents in this folder to ingest them into the ChromaDB
`sfrs_knowledge` collection.

Supported file types
--------------------
  .txt   Plain text documents
  .pdf   PDF documents (text extraction only — no OCR for scanned images)

Documents to add here
---------------------
  - SFRS standards and interpretations (download from ASC: asc.gov.sg)
  - SFRS for Small Entities (SFRS(SE))
  - IRAS e-Tax Guides (download from: iras.gov.sg/taxes/corporate-income-tax)
  - ACRA filing guides and XBRL taxonomy documentation (acra.gov.sg)
  - CPF contribution rate tables (cpf.gov.sg)
  - Any client-specific accounting policy documents

How to ingest
-------------
  1. Drop your .txt or .pdf files into this folder
  2. Ensure ChromaDB is running:  docker run -p 8000:8000 chromadb/chroma
  3. Ensure OPENAI_API_KEY is set in .env.local
  4. Run the ingestion script:    npx tsx scripts/ingest.ts

Each document is split into chunks of ~500 tokens with 50-token overlap,
converted to embeddings via OpenAI text-embedding-3-small, and stored in
the `sfrs_knowledge` ChromaDB collection with metadata:
  { source_file, chunk_index, topic }

The `topic` field is derived from the filename (without extension).

Note: Re-running the ingestion script on the same file will add duplicate
chunks. Wipe and recreate the collection if you need a clean re-ingest.
