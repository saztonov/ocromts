import type { Comparison, ComparisonDetail, ComparisonMethod } from '../types';

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
  extractBatchConcurrency?: 1 | 3,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('orderFile', orderFile);
  form.append('invoiceFile', invoiceFile);
  if (name?.trim()) {
    form.append('name', name.trim());
  }
  if (extractBatchConcurrency === 1 || extractBatchConcurrency === 3) {
    form.append('extractBatchConcurrency', String(extractBatchConcurrency));
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
  const raw = await request<Record<string, unknown>>(`/comparisons/${id}`);

  // Backend returns a flat object; reshape to match ComparisonDetail
  const { order_items, invoice_items, comparison_results, ...rest } = raw as {
    order_items: ComparisonDetail['orderItems'];
    invoice_items: ComparisonDetail['invoiceItems'];
    comparison_results: ComparisonDetail['results'];
    [key: string]: unknown;
  };

  return {
    comparison: rest as unknown as ComparisonDetail['comparison'],
    orderItems: order_items ?? [],
    invoiceItems: invoice_items ?? [],
    results: comparison_results ?? [],
  };
}

export async function cancelComparison(id: string): Promise<void> {
  await request<{ success: boolean }>(`/comparisons/${id}/cancel`, { method: 'POST' });
}

export async function deleteComparison(id: string): Promise<void> {
  await request<{ success: boolean }>(`/comparisons/${id}`, { method: 'DELETE' });
}

export async function startCompareWithMethod(id: string, method: ComparisonMethod): Promise<void> {
  await request<{ id: string; status: string }>(`/comparisons/${id}/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method }),
  });
}

export async function retryStageAItem(id: string, side: 'order' | 'invoice', position: number): Promise<void> {
  await request<{ success: boolean }>(`/comparisons/${id}/retry-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ side, position }),
  });
}
