/**
 * app/api/payroll/employees/[id]/route.ts
 *
 * PUT    /api/payroll/employees/[id]
 *   Updates an existing employee record.
 *   Input: { schemaName, name?, nric_fin?, dob?, citizenship?, monthly_salary? }
 *   Returns: the updated employee row.
 *
 * DELETE /api/payroll/employees/[id]
 *   Deletes an employee record.
 *   Input: { schemaName } in body (or schemaName as query param)
 *   Returns: { success: true }
 *
 * Note: The [id] segment is the employee UUID from the employees table.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  let body: {
    schemaName: string;
    name?: string;
    nric_fin?: string | null;
    dob?: string;
    citizenship?: string;
    monthly_salary?: number;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { schemaName, ...updates } = body;

  if (!schemaName) {
    return NextResponse.json({ error: "schemaName is required" }, { status: 400 });
  }

  // Build update payload — only include fields that were provided
  const updatePayload: Record<string, unknown> = {};
  if (updates.name !== undefined) updatePayload.name = updates.name;
  if (updates.nric_fin !== undefined) updatePayload.nric_fin = updates.nric_fin;
  if (updates.dob !== undefined) updatePayload.dob = updates.dob;
  if (updates.citizenship !== undefined) updatePayload.citizenship = updates.citizenship;
  if (updates.monthly_salary !== undefined) updatePayload.monthly_salary = updates.monthly_salary;

  if (Object.keys(updatePayload).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .schema(schemaName)
    .from("employees")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json(
      { error: `Failed to update employee: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ employee: data });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  // Accept schemaName from query param (DELETE requests often have no body)
  const { searchParams } = new URL(req.url);
  let schemaName = searchParams.get("schemaName");

  // Fall back to body if not in query params
  if (!schemaName) {
    try {
      const body = await req.json() as { schemaName?: string };
      schemaName = body.schemaName ?? null;
    } catch {
      // No body — that's fine
    }
  }

  if (!schemaName) {
    return NextResponse.json({ error: "schemaName is required" }, { status: 400 });
  }

  const { error } = await supabase
    .schema(schemaName)
    .from("employees")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json(
      { error: `Failed to delete employee: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
