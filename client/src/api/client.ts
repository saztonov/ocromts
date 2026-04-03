import type { Comparison, ComparisonDetail } from '../types';

const BASE = '/api';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, init);
  if (!res.ok) {
    const body = await res.text();
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (body) message = body;
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function createComparison(
  orderFile: File,
  invoiceFile: File,
  name?: string,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('orderFile', orderFile);
  form.append('invoiceFile', invoiceFile);
  if (name?.trim()) {
    form.append('name', name.trim());
  }
  return request<{ id: string }>('/comparisons', {
    method: 'POST',
    body: form,
  });
}

export async function getComparisons(): Promise<Comparison[]> {
  return request<Comparison[]>('/comparisons');
}

export async function getComparison(id: string): Promise<ComparisonDetail> {
  return request<ComparisonDetail>(`/comparisons/${id}`);
}

export async function deleteComparison(id: string): Promise<void> {
  await fetch(`${BASE}/comparisons/${id}`, { method: 'DELETE' });
}
