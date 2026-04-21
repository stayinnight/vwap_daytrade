import { Low } from "lowdb/lib";
import SymbolState from "../../core/state";

export default class StateService {
    db: Low<Record<string, SymbolState>>;

    constructor(db: Low<Record<string, SymbolState>>) {
        this.db = db;
    }

    async getAll(): Promise<Record<string, SymbolState>> {
        await this.db.read();
        return this.db.data || {};
    }

    async getSymbolState(symbol: string): Promise<SymbolState | undefined> {
        await this.db.read();
        return this.db.data[symbol] || {};
    }

    async setSymbolState(symbol: string, state: SymbolState) {
        await this.db.read();
        this.db.data[symbol] = state;
        await this.db.write();
    }

    async clear() {
        await this.db.read();
        this.db.data = {};
        await this.db.write();
    }
}