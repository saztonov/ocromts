CREATE TABLE IF NOT EXISTS comparisons (
    id TEXT PRIMARY KEY,
    name TEXT,
    order_filename TEXT NOT NULL,
    invoice_filename TEXT NOT NULL,
    invoice_file_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    summary_json TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    raw_name TEXT NOT NULL,
    material_type TEXT,
    gost TEXT,
    params_json TEXT,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    raw_name TEXT NOT NULL,
    material_type TEXT,
    gost TEXT,
    params_json TEXT,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    unit_price REAL,
    total_price REAL
);

CREATE TABLE IF NOT EXISTS comparison_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
    order_item_id INTEGER REFERENCES order_items(id),
    invoice_item_id INTEGER REFERENCES invoice_items(id),
    match_status TEXT NOT NULL,
    match_confidence REAL,
    quantity_status TEXT,
    quantity_diff_pct REAL,
    conversion_note TEXT,
    discrepancies_json TEXT,
    reasoning TEXT
);
