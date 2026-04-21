import { StrategyConfig } from '../../interface/config'
import { Low } from "lowdb/lib";

// 配置数据服务
export class ConfigService {
    db: Low<StrategyConfig>;

    constructor(db: Low<StrategyConfig>) {
        this.db = db;
    }

    async setConfig(config: StrategyConfig) {
        await this.db.read();
        this.db.data = config;      
        await this.db.write();
    }

    async getConfig() {
        await this.db.read();
        return this.db.data;
    }
}