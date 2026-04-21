import fs from 'fs';
import { resolve } from 'path';
import StateService from './collections/states';
import { Low } from 'lowdb/lib';
import SymbolState from '../core/state';

enum DBCollection {
    States = 'states', // 持仓状态
}

const DATA_ROOT = './data';

class DB {
    states: StateService | null = null;

    constructor() {
        this.states = null;
    }

    connect() {
        return Promise.all(Object.values(DBCollection).map(async collection => {
            const dbPath = resolve(DATA_ROOT, collection + '.json');
            if (!fs.existsSync(dbPath)) {
                fs.mkdirSync(resolve(DATA_ROOT), { recursive: true });
                fs.writeFileSync(dbPath, '{}');
            }
            const { Low } = await import('lowdb')
            const { JSONFile } = await import('lowdb/node')
            const adapter = new JSONFile(dbPath);
            const db = new Low(adapter, {});

            let Service = null;
            switch (collection) {
                case DBCollection.States:
                    Service = new StateService(db as Low<Record<string, SymbolState>>);
                    break;
            }
            if (!Service) {
                throw new Error(`[DB] 未实现 ${collection} 服务`);
            }

            this[collection] = Service;
        }))
    }
}

export { DBCollection, DB }