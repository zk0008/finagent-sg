/**
 * app/api/payroll/employees/route.ts
 *
 * GET  /api/payroll/employees?schemaName=...&entity_id=...
 *   Returns all employee records for the given entity.
 *
 * POST /api/payroll/employees
 *   Creates a new employee record.
 *   Input: { schemaName, entity_id, name, nric_fin?, dob, citizenship, monthly_salary }
 *   Returns: the inserted employee row including the generated id.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const schemaName = searchParams.get("schemaName");
  const entity_id = searchParams.get("entity_id");

  if (!schemaName || !entity_id) {
    return NextResponse.json(
      { error: "schemaName and entity_id query parameters are required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .schema(schemaName)
    .from("employees")
    .select("*")
    .eq("entity_id", entity_id)
    .order("name", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: `Failed to fetch employees: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ employees: data ?? [] });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    schemaName: string;
    entity_id: string;
    name: string;
    nric_fin?: string | null;
    dob: string;
    citizenship: string;
    monthly_salary: number;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { schemaName, entity_id, name, nric_fin, dob, citizenship, monthly_salary } = body;

  if (!schemaName || !entity_id || !name || !dob || !citizenship || monthly_salary == null) {
    return NextResponse.json(
      { error: "schemaName, entity_id, name, dob, citizenship, and monthly_salary are required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .schema(schemaName)
    .from("employees")
    .insert({
      entity_id,
      name,
      nric_fin: nric_fin ?? null,
      dob,
      citizenship,
      monthly_salary,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json(
      { error: `Failed to create employee: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ employee: data }, { status: 201 });
}
