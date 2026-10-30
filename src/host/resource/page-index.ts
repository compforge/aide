import type { DatabaseSync } from "node:sqlite";

/** @spec Index lookup and key order share one covering index; projection changes commit with resource indexes.
 * @link docs/plugin/resource.md#分页查询
 */
export function installPageIndex(db: DatabaseSync) {
  db.exec("SAVEPOINT install_page_index");
  try {
    const existed = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_page_indexes'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS resource_page_indexes (
      source TEXT NOT NULL REFERENCES resources(key) ON DELETE CASCADE,
      index_name TEXT NOT NULL, index_value TEXT NOT NULL, scope TEXT NOT NULL,
      api_version TEXT NOT NULL, kind TEXT NOT NULL, namespace TEXT NOT NULL, resource_name TEXT NOT NULL,
      PRIMARY KEY(source,index_name,index_value));
      CREATE INDEX IF NOT EXISTS resource_page_lookup ON resource_page_indexes
        (scope,api_version,kind,index_name,index_value,namespace,resource_name,source);
      CREATE TABLE IF NOT EXISTS resource_page_secrets (id INTEGER PRIMARY KEY, secret TEXT NOT NULL);
      INSERT OR IGNORE INTO resource_page_secrets VALUES (1,hex(randomblob(32)));
      CREATE TRIGGER IF NOT EXISTS resource_page_index_insert AFTER INSERT ON resource_indexes BEGIN
        INSERT INTO resource_page_indexes SELECT NEW.source,NEW.name,NEW.value,r.scope,
          json_extract(r.data,'$.object.apiVersion'),json_extract(r.data,'$.object.kind'),
          json_extract(r.data,'$.object.metadata.namespace'),json_extract(r.data,'$.object.metadata.name')
          FROM resources r WHERE r.key=NEW.source;
      END;
      CREATE TRIGGER IF NOT EXISTS resource_page_index_delete AFTER DELETE ON resource_indexes BEGIN
        DELETE FROM resource_page_indexes WHERE source=OLD.source AND index_name=OLD.name AND index_value=OLD.value;
      END;`);
    if (!existed) db.exec(`INSERT INTO resource_page_indexes SELECT i.source,i.name,i.value,r.scope,
      json_extract(r.data,'$.object.apiVersion'),json_extract(r.data,'$.object.kind'),
      json_extract(r.data,'$.object.metadata.namespace'),json_extract(r.data,'$.object.metadata.name')
      FROM resource_indexes i JOIN resources r ON r.key=i.source`);
    db.exec("RELEASE install_page_index");
  } catch (error) {
    db.exec("ROLLBACK TO install_page_index; RELEASE install_page_index");
    throw error;
  }
}
