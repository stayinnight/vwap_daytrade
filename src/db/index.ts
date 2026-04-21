import { DB } from './connect';

export let db: DB | null = null;

export const initDB = async () => {
    if (!db) {
        db = new DB();
        await db.connect();
    }
    return db;
}
