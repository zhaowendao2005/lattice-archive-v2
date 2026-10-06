import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import Database from 'better-sqlite3';

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    const userDataPath = app.getPath('userData');
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    const dbPath = path.join(userDataPath, 'lattice_archive.db');
    console.log('[SQLite] Opening database at:', dbPath);

    dbInstance = new Database(dbPath, {
      verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
    });

    // Enable WAL mode for better concurrency and performance
    dbInstance.pragma('journal_mode = WAL');

    // Initialize initial tables
    initTables(dbInstance);
  }
  return dbInstance;
}

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS archives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT,
      tags TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Insert seed data if empty
  const count = db.prepare('SELECT count(*) as count FROM archives').get() as { count: number };
  if (count.count === 0) {
    const insert = db.prepare(`
      INSERT INTO archives (title, category, content, tags)
      VALUES (?, ?, ?, ?)
    `);

    insert.run(
      'Quantum Lattice Simulation v1',
      'Research',
      'Initial quantum crystal lattice parameter data and simulation matrix results.',
      JSON.stringify(['quantum', 'simulation', 'physics'])
    );
    insert.run(
      'System Architecture Blueprint',
      'Design',
      'Capacitor + Electron + Vue 3 + Tailwind CSS + Better-SQLite3 integrated design documentation.',
      JSON.stringify(['architecture', 'desktop', 'mobile'])
    );
    insert.run(
      'Optical Diffraction Measurement',
      'Experiment',
      'Recorded photon beam diffraction patterns across the sub-micron lattice grid.',
      JSON.stringify(['optics', 'data', 'laser'])
    );
    console.log('[SQLite] Seeded initial archive records.');
  }
}
