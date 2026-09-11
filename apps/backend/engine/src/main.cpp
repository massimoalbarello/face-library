#include "engine.h"
#include "httplib.h"
#include <csignal>
#include <sys/stat.h>
using httplib::Request;
using httplib::Response;
std::string env(const char *k, const std::string &fallback = "") {
  const char *v = getenv(k);
  return v && *v ? v : fallback;
}
int64_t now() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
struct HttpError : std::runtime_error {
  int status;
  HttpError(int s, const std::string &m) : std::runtime_error(m), status(s) {}
};
void reply(Response &r, const json &j, int status = 200) {
  r.status = status;
  r.set_content(j.dump(), "application/json");
}
json body(const Request &q) {
  try {
    return json::parse(q.body);
  } catch (...) {
    throw HttpError(400, "Invalid JSON request");
  }
}
int64_t id_at(const Request &q, int i = 1) {
  try {
    auto id = std::stoll(q.matches[i]);
    if (id < 1)
      throw std::exception();
    return id;
  } catch (...) {
    throw HttpError(400, "Invalid identifier");
  }
}
int page_offset(const Request &q) {
  if (!q.has_param("offset"))
    return 0;
  try {
    return std::clamp(std::stoi(q.get_param_value("offset")), 0, 1000000);
  } catch (...) {
    throw HttpError(400, "Invalid page");
  }
}
std::string trim_name(std::string s) {
  s.erase(s.begin(), std::find_if(s.begin(), s.end(), [](unsigned char c) {
            return !std::isspace(c);
          }));
  s.erase(std::find_if(s.rbegin(), s.rend(),
                       [](unsigned char c) { return !std::isspace(c); })
              .base(),
          s.end());
  return s;
}
class App {
public:
  fs::path root;
  DB db;
  std::mutex mutex;
  Engine engine;
  httplib::Server server;
  std::string key_hash;
  bool secure;
  explicit App(fs::path p)
      : root(p), db((root / "library.sqlite").string()),
        engine(db, root, mutex), secure(!env("NIBRUN_HOSTNAME").empty()) {
    for (auto f : {"originals", "photos", "views", "models"})
      fs::create_directories(root / f);
    auto token = env("FACE_CORE_TOKEN");
    if (token.size() < 32)
      throw std::runtime_error(
          "Start Face Library through its Better Auth server");
    key_hash = digest(token);
    db.exec(R"SQL(
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 INSERT OR IGNORE INTO settings VALUES('schema','1'),('threshold','0.363'),('embedding_model','sface-2021dec-fp32-128');
 CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY AUTOINCREMENT,filename TEXT NOT NULL,original TEXT NOT NULL,thumbnail TEXT NOT NULL DEFAULT '',mime TEXT NOT NULL,bytes INTEGER NOT NULL,width INTEGER NOT NULL DEFAULT 0,height INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',error TEXT NOT NULL DEFAULT '',created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
 CREATE TABLE IF NOT EXISTS faces(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL DEFAULT '',created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
 CREATE TABLE IF NOT EXISTS views(id INTEGER PRIMARY KEY AUTOINCREMENT,photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,face_id INTEGER NOT NULL REFERENCES faces(id),crop TEXT NOT NULL,x REAL NOT NULL,y REAL NOT NULL,w REAL NOT NULL,h REAL NOT NULL,confidence REAL NOT NULL,manual INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS views_photo ON views(photo_id);
 CREATE INDEX IF NOT EXISTS views_face ON views(face_id);
 CREATE TABLE IF NOT EXISTS embeddings(view_id INTEGER PRIMARY KEY REFERENCES views(id) ON DELETE CASCADE,vector BLOB NOT NULL CHECK(length(vector)=512));
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
 )SQL");
    bool has_cover = false;
    for (auto &column : db.query("PRAGMA table_info(faces)"))
      if (column["name"] == "cover_view_id")
        has_cover = true;
    if (!has_cover) {
      Transaction migration(db);
      db.exec("ALTER TABLE faces ADD COLUMN cover_view_id INTEGER REFERENCES "
              "views(id) ON DELETE SET NULL");
      repair_face_covers(db);
      db.run("UPDATE settings SET value='2' WHERE key='schema'");
      migration.commit();
    }
    repair_face_covers(db);
    server.set_payload_max_length(20 * 1024 * 1024);
    server.set_read_timeout(30);
    server.set_write_timeout(30);
    server.set_idle_interval(1);
    // Idle browser connections must not monopolize this small worker pool.
    server.set_keep_alive_max_count(1);
    server.new_task_queue = []() { return new httplib::ThreadPool(3, 6); };
    server.set_pre_routing_handler([this](const Request &q, Response &r) {
      r.set_header("X-Content-Type-Options", "nosniff");
      r.set_header("Referrer-Policy", "same-origin");
      r.set_header("Cache-Control", "no-store");
      r.set_header("Content-Security-Policy",
                   "default-src 'self'; img-src 'self' blob: data:; style-src "
                   "'self' 'unsafe-inline'; script-src 'self'; connect-src "
                   "'self'; object-src 'none'; base-uri 'none'; "
                   "frame-ancestors 'none'; form-action 'self'");
      if (q.method == "OPTIONS") {
        reply(r, {{"error", "Cross-origin requests are disabled"}}, 403);
        return httplib::Server::HandlerResponse::Handled;
      }
      if (q.method != "GET" && q.method != "HEAD") {
        if (q.get_header_value("X-Requested-With") != "FaceLibrary") {
          reply(r, {{"error", "Missing request header"}}, 403);
          return httplib::Server::HandlerResponse::Handled;
        }
        auto origin = q.get_header_value("Origin");
        auto host =
            secure ? env("NIBRUN_HOSTNAME") : q.get_header_value("Host");
        if (!origin.empty() &&
            origin != (secure ? "https://" : "http://") + host) {
          reply(r, {{"error", "Cross-origin request refused"}}, 403);
          return httplib::Server::HandlerResponse::Handled;
        }
      }
      if (!authenticated(q)) {
        reply(r, {{"error", "Sign in to your library"}}, 401);
        return httplib::Server::HandlerResponse::Handled;
      }
      return httplib::Server::HandlerResponse::Unhandled;
    });
    server.set_exception_handler(
        [](const Request &, Response &r, std::exception_ptr ep) {
          try {
            if (ep)
              std::rethrow_exception(ep);
          } catch (const HttpError &e) {
            reply(r, {{"error", e.what()}}, e.status);
          } catch (const json::exception &) {
            reply(r, {{"error", "Invalid request fields"}}, 400);
          } catch (const std::exception &e) {
            std::cerr << "Request error: " << e.what() << std::endl;
            reply(r,
                  {{"error", "The operation could not be completed. Check "
                             "available disk space and try again."}},
                  500);
          }
        });
    server.set_error_handler([](const Request &, Response &r) {
      if (r.body.empty())
        reply(
            r,
            {{"error", r.status == 413 ? "Photo exceeds the 20 MB upload limit"
                                       : "Request not found"}},
            r.status);
    });
    routes();
  }
  bool authenticated(const Request &q) {
    const auto token = q.get_header_value("Authorization");
    return token.rfind("Bearer ", 0) == 0 &&
           equal_secret(digest(token.substr(7)), key_hash);
  }
  void require_ready() {
    if (!engine.ready)
      throw HttpError(503,
                      "Face models are still preparing. Try again shortly.");
  }
  void require_face(int64_t id) {
    if (db.query("SELECT id FROM faces WHERE id=?", {id}).empty())
      throw HttpError(404, "Face not found");
  }
  void pin(int64_t id) {
    db.run("UPDATE views SET manual=1 WHERE face_id=?", {id});
  }
  void refresh_index() {
    repair_face_covers(db);
    engine.index.load(db);
    engine.index.save(root);
  }
  void routes() {
    server.Get("/", [](const Request &, Response &r) {
      r.set_content(PAGE, "text/html; charset=utf-8");
    });
    server.Get("/app.js", [](const Request &, Response &r) {
      r.set_content(APPJS, "text/javascript");
    });
    server.Get("/camera.js", [](const Request &, Response &r) {
      r.set_content(CAMERAJS, "text/javascript");
    });
    server.Get("/dm-sans.woff2", [](const Request &, Response &r) {
      r.set_content(reinterpret_cast<const char *>(DMSANS), sizeof(DMSANS),
                    "font/woff2");
    });
    server.Get("/style.css", [](const Request &, Response &r) {
      r.set_content(STYLE, "text/css");
    });
    server.Get("/favicon.svg", [](const Request &, Response &r) {
      r.set_content(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect "
          "width='32' height='32' rx='9' fill='#171717'/><circle cx='16' "
          "cy='12' r='5' fill='#fafafa'/><path d='M6 27a10 10 0 0 1 20 0' "
          "fill='#fafafa'/></svg>",
          "image/svg+xml");
    });
    server.Get("/health", [this](const Request &, Response &r) {
      reply(r, {{"status", engine.ready ? "ready" : "preparing"},
                {"version", "1.3.0"}});
    });
    server.Get("/api/status", [this](const Request &, Response &r) {
      std::lock_guard<std::mutex> l(mutex);
      auto counts = db.query(
          "SELECT (SELECT count(*) FROM photos) photos,(SELECT count(*) FROM "
          "views) views,(SELECT count(*) FROM faces WHERE EXISTS(SELECT 1 FROM "
          "views WHERE face_id=faces.id)) faces,(SELECT count(*) FROM photos "
          "WHERE status IN ('queued','processing')) pending,(SELECT count(*) "
          "FROM photos WHERE status='error') errors,(SELECT count(*) FROM "
          "views WHERE manual=1) fixed")[0];
      counts["ready"] = bool(engine.ready);
      counts["state"] = engine.state;
      counts["modelError"] = engine.error;
      counts["threshold"] = engine.threshold();
      counts["freeBytes"] = fs::space(root).available;
      reply(r, counts);
    });
    server.Post("/api/settings", [this](const Request &q, Response &r) {
      double value = body(q).at("threshold");
      if (!std::isfinite(value) || value < 0 || value > 1)
        throw HttpError(400, "Similarity must be between 0 and 1");
      std::lock_guard<std::mutex> l(mutex);
      db.run("UPDATE settings SET value=? WHERE key='threshold'",
             {std::to_string(value)});
      reply(r, {{"threshold", value}});
    });
    server.Post("/api/regroup", [this](const Request &, Response &r) {
      std::lock_guard<std::mutex> l(mutex);
      require_ready();
      auto busy = db.query("SELECT id FROM photos WHERE status IN "
                           "('queued','processing') LIMIT 1");
      if (!busy.empty())
        throw HttpError(
            409, "Wait for photo processing to finish before regrouping");
      int changed = engine.regroup();
      reply(r, {{"changed", changed}});
    });
    server.Post("/api/photos", [this](const Request &q, Response &r) {
      std::string name =
          q.has_param("name") ? q.get_param_value("name") : "Photo";
      name = fs::path(name).filename().string();
      if (name.empty() || name.size() > 255)
        throw HttpError(400, "Invalid photo filename");
      std::string ext, mime;
      if (q.body.size() >= 3 && (unsigned char)q.body[0] == 255 &&
          (unsigned char)q.body[1] == 216 && (unsigned char)q.body[2] == 255) {
        ext = ".jpg";
        mime = "image/jpeg";
      } else if (q.body.size() >= 24 &&
                 q.body.compare(0, 8, std::string("\x89PNG\r\n\x1a\n", 8)) ==
                     0) {
        ext = ".png";
        mime = "image/png";
      } else
        throw HttpError(415, "Use a JPEG or PNG photo");
      if (fs::space(root).available < q.body.size() + 128 * 1024 * 1024)
        throw HttpError(507, "Your library is almost out of disk space");
      std::string asset = "originals/" + random_hex(16) + ext;
      write_file(root / asset, q.body);
      int64_t id;
      try {
        std::lock_guard<std::mutex> l(mutex);
        id = db.run(
            "INSERT INTO photos(filename,original,mime,bytes) VALUES(?,?,?,?)",
            {name, asset, mime, q.body.size()});
      } catch (...) {
        fs::remove(root / asset);
        throw;
      }
      engine.wake.notify_one();
      reply(r, {{"id", id}, {"status", "queued"}}, 201);
    });
    server.Get("/api/photos", [this](const Request &q, Response &r) {
      std::lock_guard<std::mutex> l(mutex);
      auto rows = db.query(
          "SELECT p.*,(SELECT count(*) FROM views WHERE photo_id=p.id) "
          "view_count FROM photos p ORDER BY p.id DESC LIMIT 60 OFFSET ?",
          {page_offset(q)});
      for (auto &p : rows) {
        p["faces"] =
            db.query("SELECT DISTINCT f.id,f.name FROM faces f JOIN views v ON "
                     "v.face_id=f.id WHERE v.photo_id=? ORDER BY f.id",
                     {p["id"]});
        p.erase("original");
        p.erase("thumbnail");
      }
      reply(r, {{"items", rows},
                {"total", db.query("SELECT count(*) n FROM photos")[0]["n"]}});
    });
    server.Get(R"(/api/photos/(\d+))", [this](const Request &q, Response &r) {
      std::lock_guard<std::mutex> l(mutex);
      auto rows = db.query("SELECT * FROM photos WHERE id=?", {id_at(q)});
      if (rows.empty())
        throw HttpError(404, "Photo not found");
      auto p = rows[0];
      p.erase("original");
      p.erase("thumbnail");
      p["views"] = db.query("SELECT v.*,f.name FROM views v JOIN faces f ON "
                            "f.id=v.face_id WHERE photo_id=? ORDER BY v.id",
                            {p["id"]});
      reply(r, p);
    });
    server.Post(
        R"(/api/photos/(\d+)/retry)", [this](const Request &q, Response &r) {
          std::lock_guard<std::mutex> l(mutex);
          require_ready();
          db.run("UPDATE photos SET status='queued',error='' WHERE "
                 "id=? AND (status='error' OR (status='ready' AND NOT "
                 "EXISTS(SELECT 1 FROM views WHERE photo_id=photos.id)))",
                 {id_at(q)});
          engine.wake.notify_one();
          reply(r, {{"ok", true}});
        });
    server.Delete(R"(/api/photos/(\d+))", [this](const Request &q,
                                                 Response &r) {
      std::lock_guard<std::mutex> l(mutex);
      int64_t id = id_at(q);
      auto ps = db.query("SELECT * FROM photos WHERE id=?", {id});
      if (ps.empty())
        throw HttpError(404, "Photo not found");
      if (ps[0]["status"] == "processing")
        throw HttpError(409, "Wait for this photo to finish processing");
      std::vector<std::string> paths = {ps[0]["original"], ps[0]["thumbnail"]};
      for (auto &v : db.query("SELECT crop FROM views WHERE photo_id=?", {id}))
        paths.push_back(v["crop"]);
      Transaction tx(db);
      db.run("DELETE FROM photos WHERE id=?", {id});
      db.run("DELETE FROM faces WHERE NOT EXISTS(SELECT 1 FROM views WHERE "
             "face_id=faces.id)");
      tx.commit();
      refresh_index();
      for (auto &p : paths)
        if (!p.empty()) {
          std::error_code ec;
          fs::remove(root / p, ec);
        }
      reply(r, {{"ok", true}});
    });
    server.Get("/api/faces", [this](const Request &q, Response &r) {
      std::lock_guard<std::mutex> l(mutex);
      std::string s = q.has_param("search") ? q.get_param_value("search") : "";
      if (s.size() > 120)
        throw HttpError(400, "Search is too long");
      auto rows = db.query(
          "SELECT f.*,(SELECT count(*) FROM views WHERE face_id=f.id) "
          "view_count,(SELECT count(DISTINCT photo_id) FROM views WHERE "
          "face_id=f.id) photo_count,f.cover_view_id cover,(SELECT count(*) "
          "FROM views "
          "WHERE face_id=f.id AND manual=1) fixed FROM faces f WHERE "
          "EXISTS(SELECT 1 FROM views WHERE face_id=f.id) AND (f.name LIKE ? "
          "OR CAST(f.id AS TEXT)=?) ORDER BY (f.name=''),f.name,f.id LIMIT 60 "
          "OFFSET ?",
          {"%" + s + "%", s, page_offset(q)});
      reply(r, {{"items", rows},
                {"total",
                 db.query("SELECT count(*) n FROM faces f WHERE EXISTS(SELECT "
                          "1 FROM views WHERE face_id=f.id) AND (f.name LIKE ? "
                          "OR CAST(f.id AS TEXT)=?)",
                          {"%" + s + "%", s})[0]["n"]}});
    });
    server.Get(R"(/api/faces/(\d+))", [this](const Request &q, Response &r) {
      std::lock_guard<std::mutex> l(mutex);
      int64_t id = id_at(q);
      require_face(id);
      auto f = db.query("SELECT * FROM faces WHERE id=?", {id})[0];
      f["cover"] = f["cover_view_id"];
      f["views"] = db.query(
          "SELECT v.*,p.filename FROM views v JOIN photos p ON p.id=v.photo_id "
          "WHERE face_id=? ORDER BY v.id DESC LIMIT 120 OFFSET ?",
          {id, page_offset(q)});
      f["view_count"] = db.query("SELECT count(*) n FROM views WHERE face_id=?",
                                 {id})[0]["n"];
      f["photos"] =
          db.query("SELECT p.id,p.filename,count(*) views FROM photos p JOIN "
                   "views v ON v.photo_id=p.id WHERE v.face_id=? GROUP BY p.id "
                   "ORDER BY p.id DESC LIMIT 120 OFFSET ?",
                   {id, page_offset(q)});
      reply(r, f);
    });
    server.Patch(R"(/api/faces/(\d+))", [this](const Request &q, Response &r) {
      std::string name = trim_name(body(q).at("name"));
      if (name.size() > 120)
        throw HttpError(400, "Name must be at most 120 characters");
      std::lock_guard<std::mutex> l(mutex);
      int64_t id = id_at(q);
      require_face(id);
      Transaction tx(db);
      db.run("UPDATE faces SET name=? WHERE id=?", {name, id});
      pin(id);
      tx.commit();
      refresh_index();
      reply(r, {{"ok", true}});
    });
    server.Put(R"(/api/faces/(\d+)/cover)", [this](const Request &q,
                                                   Response &r) {
      int64_t view = body(q).at("view_id");
      std::lock_guard<std::mutex> l(mutex);
      int64_t face = id_at(q);
      require_face(face);
      if (db.query("SELECT 1 FROM views WHERE id=? AND face_id=?", {view, face})
              .empty())
        throw HttpError(400, "Choose a view belonging to this face");
      db.run("UPDATE faces SET cover_view_id=? WHERE id=?", {view, face});
      reply(r, {{"ok", true}, {"cover", view}});
    });
    server.Post(R"(/api/faces/(\d+)/merge)", [this](const Request &q,
                                                    Response &r) {
      int64_t target = body(q).at("target");
      std::lock_guard<std::mutex> l(mutex);
      int64_t source = id_at(q);
      if (target == source)
        throw HttpError(400, "Choose a different face");
      require_face(source);
      require_face(target);
      Transaction tx(db);
      pin(source);
      pin(target);
      db.run("UPDATE views SET face_id=? WHERE face_id=?", {target, source});
      db.run("DELETE FROM faces WHERE id=?", {source});
      tx.commit();
      refresh_index();
      reply(r, {{"id", target}});
    });
    server.Post("/api/views/move", [this](const Request &q, Response &r) {
      auto b = body(q);
      std::vector<int64_t> ids = b.at("ids");
      int64_t target = b.value("target", int64_t(0));
      if (ids.empty() || ids.size() > 500)
        throw HttpError(400, "Select between 1 and 500 views");
      std::lock_guard<std::mutex> l(mutex);
      Transaction tx(db);
      if (target)
        require_face(target);
      else
        target = db.run("INSERT INTO faces(name) VALUES('')");
      std::set<int64_t> sources;
      for (auto id : ids) {
        auto v = db.query("SELECT face_id FROM views WHERE id=?", {id});
        if (v.empty())
          throw HttpError(404, "A selected view no longer exists");
        sources.insert(v[0]["face_id"].get<int64_t>());
      }
      for (auto id : sources)
        pin(id);
      pin(target);
      for (auto id : ids)
        db.run("UPDATE views SET face_id=?,manual=1 WHERE id=?", {target, id});
      db.run("DELETE FROM faces WHERE name='' AND NOT EXISTS(SELECT 1 FROM "
             "views WHERE face_id=faces.id)");
      tx.commit();
      refresh_index();
      reply(r, {{"id", target}});
    });
    server.Get(
        R"(/assets/photos/(\d+)/(original|preview))",
        [this](const Request &q, Response &r) {
          std::string path, mime;
          {
            std::lock_guard<std::mutex> l(mutex);
            auto ps = db.query("SELECT * FROM photos WHERE id=?", {id_at(q)});
            if (ps.empty())
              throw HttpError(404, "Photo not found");
            bool original = q.matches[2] == "original";
            path = ps[0][original ? "original" : "thumbnail"];
            mime = original ? ps[0]["mime"].get<std::string>() : "image/jpeg";
            if (original)
              r.set_header("Content-Disposition",
                           "attachment; filename=\"photo-" +
                               std::to_string(id_at(q)) +
                               (mime == "image/png" ? ".png" : ".jpg") + "\"");
          }
          if (path.empty() || !fs::exists(root / path))
            throw HttpError(404, "Preview is still preparing");
          r.set_file_content((root / path).string(), mime);
          r.set_header("Cache-Control", "private, max-age=3600");
        });
    server.Get(R"(/assets/views/(\d+))", [this](const Request &q, Response &r) {
      std::string path;
      {
        std::lock_guard<std::mutex> l(mutex);
        auto vs = db.query("SELECT crop FROM views WHERE id=?", {id_at(q)});
        if (vs.empty())
          throw HttpError(404, "View not found");
        path = vs[0]["crop"];
      }
      r.set_file_content((root / path).string(), "image/jpeg");
      r.set_header("Cache-Control", "private, max-age=3600");
    });
  }
  void run() {
    engine.start();
    int port = std::stoi(env("FACE_CORE_PORT", "3048"));
    std::cout << "Face Library engine listening on 127.0.0.1:" << port
              << "; data=" << root << std::endl;
    if (!server.listen("127.0.0.1", port))
      throw std::runtime_error("Could not listen on HTTP port");
  }
};
int main() {
  try {
    signal(SIGPIPE, SIG_IGN);
    umask(0077);
    setenv("OPENCV_IO_MAX_IMAGE_PIXELS", "16000000", 0);
    setenv("OPENCV_IO_MAX_IMAGE_WIDTH", "20000", 0);
    setenv("OPENCV_IO_MAX_IMAGE_HEIGHT", "20000", 0);
    fs::path root = env("NIBRUN_DATA_DIR", env("DATA_DIR", "./data"));
    fs::create_directories(root);
    App app(root);
    app.run();
    return 0;
  } catch (const std::exception &e) {
    std::cerr << "Startup failed: " << e.what() << std::endl;
    return 1;
  }
}
