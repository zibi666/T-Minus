// sql.js 没有自带可用的类型声明，这里只声明本项目实际用到的那一小块表面。
declare module 'sql.js' {
  export interface Statement {
    bind(values?: unknown[] | Record<string, unknown>): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }
  export interface Database {
    run(sql: string, params?: unknown[]): SqlJsDatabase;
    exec(sql: string, params?: unknown[]): QueryResult[];
    prepare(sql: string, params?: unknown[]): Statement;
    export(): Uint8Array;
    close(): void;
  }
  export interface QueryResult { columns: string[]; values: unknown[][] }
  export type SqlJsDatabase = Database;
  export interface SqlJsStatic { Database: new (data?: ArrayLike<number> | null) => Database }
  export default function initSqlJs(config?: unknown): Promise<SqlJsStatic>;
}
