CREATE TABLE IF NOT EXISTS comparisons (
    id TEXT PRIMARY KEY,
    name TEXT,
    order_filename TEXT NOT NULL,
    invoice_filename TEXT NOT NULL,
    invoice_file_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    progress INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    summary_json TEXT,
    comparison_method TEXT,
    stage_a_total INTEGER NOT NULL DEFAULT 0,
    stage_a_done INTEGER NOT NULL DEFAULT 0,
    stage_a_failed_position INTEGER,
    stage_a_failed_side TEXT,
    stage_a_error TEXT,
    stage_a_completed_at TEXT,
    user_prompt TEXT
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
    unit TEXT NOT NULL,
    comment TEXT,
    comment_has_units INTEGER NOT NULL DEFAULT 0
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
    reasoning TEXT,
    method TEXT NOT NULL DEFAULT 'single',
    split_json TEXT
);
