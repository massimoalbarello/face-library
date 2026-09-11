#pragma once
#include "json.hpp"
#include "sqlite3.h"
#include <stdexcept>
#include <string>
#include <vector>
using json = nlohmann::json;
struct DB {
  sqlite3 *db = nullptr;
  explicit DB(const std::string &p) {
    if (sqlite3_open(p.c_str(), &db) != SQLITE_OK)
      throw std::runtime_error("Cannot open database");
    sqlite3_busy_timeout(db, 5000);
    exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA "
         "synchronous=FULL; PRAGMA cache_size=-2048;");
  }
  ~DB() { sqlite3_close(db); }
  void exec(const std::string &s) {
    char *e = nullptr;
    if (sqlite3_exec(db, s.c_str(), nullptr, nullptr, &e) != SQLITE_OK) {
      std::string m = e ? e : "Database failure";
      sqlite3_free(e);
      throw std::runtime_error(m);
    }
  }
  struct Stmt {
    sqlite3_stmt *s;
    DB &d;
    Stmt(DB &db, const std::string &q, const json &values) : d(db) {
      const json args = values.is_array() ? values : json::array({values});
      if (sqlite3_prepare_v2(d.db, q.c_str(), -1, &s, nullptr) != SQLITE_OK)
        throw std::runtime_error(sqlite3_errmsg(d.db));
      for (size_t i = 0; i < args.size(); i++) {
        auto &a = args[i];
        if (a.is_null())
          sqlite3_bind_null(s, i + 1);
        else if (a.is_number_integer())
          sqlite3_bind_int64(s, i + 1, a.get<int64_t>());
        else if (a.is_number_float())
          sqlite3_bind_double(s, i + 1, a.get<double>());
        else if (a.is_boolean())
          sqlite3_bind_int(s, i + 1, a.get<bool>());
        else {
          std::string v = a.get<std::string>();
          sqlite3_bind_text(s, i + 1, v.c_str(), v.size(), SQLITE_TRANSIENT);
        }
      }
    }
    ~Stmt() { sqlite3_finalize(s); }
    int step() {
      int n = sqlite3_step(s);
      if (n != SQLITE_ROW && n != SQLITE_DONE)
        throw std::runtime_error(sqlite3_errmsg(d.db));
      return n;
    }
  };
  json query(const std::string &q, const json &a = json::array()) {
    Stmt st(*this, q, a);
    json rows = json::array();
    while (st.step() == SQLITE_ROW) {
      json row = json::object();
      for (int i = 0; i < sqlite3_column_count(st.s); i++) {
        auto k = sqlite3_column_name(st.s, i);
        switch (sqlite3_column_type(st.s, i)) {
        case SQLITE_INTEGER:
          row[k] = sqlite3_column_int64(st.s, i);
          break;
        case SQLITE_FLOAT:
          row[k] = sqlite3_column_double(st.s, i);
          break;
        case SQLITE_TEXT:
          row[k] = (const char *)sqlite3_column_text(st.s, i);
          break;
        default:
          row[k] = nullptr;
        }
      }
      rows.push_back(row);
    }
    return rows;
  }
  int64_t run(const std::string &q, const json &a = json::array()) {
    Stmt st(*this, q, a);
    st.step();
    return sqlite3_last_insert_rowid(db);
  }
  void embedding(int64_t id, const float *p, size_t n) {
    Stmt st(*this, "INSERT INTO embeddings(view_id,vector) VALUES(?,?)",
            json::array({id}));
    sqlite3_bind_blob(st.s, 2, p, n * sizeof(float), SQLITE_TRANSIENT);
    st.step();
  }
};
inline void repair_face_covers(DB &db) {
  db.run("UPDATE faces SET cover_view_id=(SELECT min(id) FROM views WHERE "
         "face_id=faces.id) "
         "WHERE cover_view_id IS NULL OR NOT EXISTS(SELECT 1 FROM views WHERE "
         "id=faces.cover_view_id AND face_id=faces.id)");
}
struct Transaction {
  DB &d;
  bool committed = false;
  explicit Transaction(DB &db) : d(db) { d.exec("BEGIN IMMEDIATE"); }
  void commit() {
    d.exec("COMMIT");
    committed = true;
  }
  ~Transaction() {
    if (!committed) {
      try {
        d.exec("ROLLBACK");
      } catch (...) {
      }
    }
  }
};
