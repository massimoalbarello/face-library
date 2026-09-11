#pragma once
#include "crypto.h"
#include "db.h"
#include "detection.h"
#include "hnswlib/hnswlib.h"
#include <array>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <opencv2/core.hpp>
#include <opencv2/dnn.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/objdetect.hpp>
#include <set>
#include <thread>
constexpr int DIM = 128;
constexpr int MAX_VIEWS = 50000;
constexpr float DEFAULT_THRESHOLD = .363F;
struct ViewMeta {
  int64_t photo, face;
  bool manual;
};
struct Index {
  hnswlib::InnerProductSpace space{DIM};
  std::unique_ptr<hnswlib::HierarchicalNSW<float>> graph;
  std::map<int64_t, ViewMeta> meta;
  std::map<int64_t, std::set<int64_t>> photo_faces;
  Index() { reset(); }
  void reset() {
    graph = std::make_unique<hnswlib::HierarchicalNSW<float>>(&space, 1024, 16,
                                                              120, 42);
    graph->setEf(100);
    meta.clear();
    photo_faces.clear();
  }
  void add(int64_t id, const float *p, ViewMeta v) {
    if (meta.size() >= MAX_VIEWS)
      throw std::runtime_error(
          "This instance supports up to 50,000 face views");
    if (graph->cur_element_count >= graph->max_elements_)
      graph->resizeIndex(std::min<size_t>(MAX_VIEWS, graph->max_elements_ * 2));
    graph->addPoint(p, id);
    meta[id] = v;
    photo_faces[v.photo].insert(v.face);
  }
  int64_t match(const float *p, int64_t photo, float threshold) {
    if (meta.empty())
      return 0;
    auto neighbors = graph->searchKnn(p, std::min<size_t>(64, meta.size()));
    float best = -2;
    int64_t face = 0;
    const auto &same_photo = photo_faces[photo];
    while (!neighbors.empty()) {
      auto [d, id] = neighbors.top();
      neighbors.pop();
      auto &m = meta.at(id);
      float score = 1 - d;
      if (m.photo != photo && !same_photo.count(m.face) && score >= threshold &&
          score > best) {
        best = score;
        face = m.face;
      }
    }
    return face;
  }
  // SQLite embeddings are authoritative; the HNSW file is a replaceable
  // acceleration artifact.
  void load(DB &db) {
    reset();
    DB::Stmt s(db,
               "SELECT e.view_id,e.vector,v.photo_id,v.face_id,v.manual FROM "
               "embeddings e JOIN views v ON v.id=e.view_id ORDER BY e.view_id",
               json::array());
    while (s.step() == SQLITE_ROW) {
      if (sqlite3_column_bytes(s.s, 1) != DIM * sizeof(float))
        throw std::runtime_error("Embedding dimension mismatch");
      std::array<float, DIM> b;
      std::memcpy(b.data(), sqlite3_column_blob(s.s, 1), sizeof b);
      add(sqlite3_column_int64(s.s, 0), b.data(),
          {sqlite3_column_int64(s.s, 2), sqlite3_column_int64(s.s, 3),
           bool(sqlite3_column_int(s.s, 4))});
    }
  }
  void save(const fs::path &root) {
    auto p = root / "face-index.hnsw";
    graph->saveIndex(p.string() + ".tmp");
    fs::rename(p.string() + ".tmp", p);
  }
};
struct Extracted {
  std::array<float, DIM> embedding;
  std::array<double, 4> box;
  float confidence;
  std::string crop;
};
struct Engine {
  DB &db;
  fs::path root;
  std::mutex &mutex;
  Index index;
  bool index_dirty = false;
  std::chrono::steady_clock::time_point last_checkpoint{};
  std::atomic<bool> ready{false}, stopping{false};
  std::string state = "Preparing models", error;
  std::condition_variable wake;
  std::thread worker;
  cv::Ptr<cv::FaceDetectorYN> detector;
  cv::Ptr<cv::FaceRecognizerSF> recognizer;
  Engine(DB &d, fs::path p, std::mutex &m) : db(d), root(p), mutex(m) {}
  ~Engine() {
    stopping = true;
    wake.notify_all();
    if (worker.joinable())
      worker.join();
  }
  double threshold() {
    return std::stod(
        db.query("SELECT value FROM settings WHERE key='threshold'")[0]["value"]
            .get<std::string>());
  }
  void start() {
    worker = std::thread([this] {
      try {
        run();
      } catch (const std::exception &e) {
        std::lock_guard<std::mutex> l(mutex);
        ready = false;
        state = "Processing stopped";
        error = e.what();
        std::cerr << error << std::endl;
      }
    });
  }
  void initialize() {
    fs::create_directories(root / "models");
    const std::string base = "/media/opencv/opencv_zoo/"
                             "47534e27c9851bb1128ccc0102f1145e27f23f98/models/";
    download_model(
        base + "face_detection_yunet/face_detection_yunet_2023mar.onnx",
        root / "models/yunet.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        300000);
    download_model(
        base + "face_recognition_sface/face_recognition_sface_2021dec.onnx",
        root / "models/sface.onnx",
        "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
        40000000);
    cv::setNumThreads(1);
    detector = cv::FaceDetectorYN::create(
        (root / "models/yunet.onnx").string(), "", {640, 640}, .85, .3, 1000,
        cv::dnn::DNN_BACKEND_OPENCV, cv::dnn::DNN_TARGET_CPU);
    recognizer = cv::FaceRecognizerSF::create(
        (root / "models/sface.onnx").string(), "", cv::dnn::DNN_BACKEND_OPENCV,
        cv::dnn::DNN_TARGET_CPU);
    std::lock_guard<std::mutex> l(mutex);
    index.load(db);
    index.save(root);
    db.run("UPDATE photos SET status='queued' WHERE status='processing'");
    auto detection_version =
        db.query("SELECT value FROM settings WHERE key='detection_version'");
    if (detection_version.empty() || detection_version[0]["value"] != "2") {
      // Retry only photos without views; named groups and manual edits stay
      // intact.
      db.run("UPDATE photos SET status='queued' WHERE status='ready' AND NOT "
             "EXISTS(SELECT 1 FROM views WHERE photo_id=photos.id)");
      db.run("INSERT OR REPLACE INTO settings(key,value) "
             "VALUES('detection_version','2')");
    }
    state = "Ready";
    error = "";
    ready = true;
  }
  static int jpeg_reduction(const std::string &b) {
    if (b.size() < 4 || (unsigned char)b[0] != 255 ||
        (unsigned char)b[1] != 216)
      return cv::IMREAD_COLOR;
    size_t p = 2;
    while (p + 4 < b.size()) {
      if ((unsigned char)b[p++] != 255)
        break;
      unsigned char marker = b[p++];
      if (marker == 255) {
        p--;
        continue;
      }
      if (marker == 217 || marker == 218)
        break;
      if (marker == 1 || (marker >= 208 && marker <= 215))
        continue;
      size_t len = ((unsigned char)b[p] << 8) | (unsigned char)b[p + 1];
      if (len < 2 || p + len > b.size())
        break;
      if ((marker >= 192 && marker <= 195) ||
          (marker >= 197 && marker <= 199) ||
          (marker >= 201 && marker <= 203) ||
          (marker >= 205 && marker <= 207)) {
        if (len < 7)
          break;
        int h = ((unsigned char)b[p + 3] << 8) | (unsigned char)b[p + 4],
            w = ((unsigned char)b[p + 5] << 8) | (unsigned char)b[p + 6];
        int m = std::max(h, w);
        return m > 8192   ? cv::IMREAD_REDUCED_COLOR_8
               : m > 4096 ? cv::IMREAD_REDUCED_COLOR_4
               : m > 2048 ? cv::IMREAD_REDUCED_COLOR_2
                          : cv::IMREAD_COLOR;
      }
      p += len;
    }
    return cv::IMREAD_COLOR;
  }
  void process(const json &p) {
    int64_t photo = p["id"];
    auto path = root / p["original"].get<std::string>();
    std::vector<fs::path> created;
    try {
      std::string bytes = read_file(path);
      int mode = jpeg_reduction(bytes);
      cv::Mat raw(1, bytes.size(), CV_8U, bytes.data());
      cv::Mat im = cv::imdecode(raw, mode);
      bytes.clear();
      bytes.shrink_to_fit();
      if (im.empty())
        throw std::runtime_error(
            "Unsupported or damaged image. Use JPEG or PNG.");
      if (im.total() > 16000000)
        throw std::runtime_error(
            "Image is too large to decode on this instance");
      if (std::max(im.cols, im.rows) > 2048) {
        double s = 2048. / std::max(im.cols, im.rows);
        cv::resize(im, im, {}, s, s, cv::INTER_AREA);
      }
      int width = im.cols, height = im.rows;
      cv::Mat thumb;
      double ts = std::min(1., 1600. / std::max(width, height));
      cv::resize(im, thumb, {}, ts, ts, cv::INTER_AREA);
      auto thumbpath = "photos/" + std::to_string(photo) + ".jpg";
      if (!cv::imwrite((root / thumbpath).string(), thumb,
                       {cv::IMWRITE_JPEG_QUALITY, 85}))
        throw std::runtime_error("Could not save photo preview");
      created.push_back(root / thumbpath);
      thumb.release();
      cv::Mat boxes = detect_oriented_faces(im, detector);
      if (boxes.rows > 200)
        throw std::runtime_error("Too many faces in one photo (maximum 200)");
      std::vector<Extracted> found;
      for (int i = 0; i < boxes.rows; i++) {
        cv::Mat box = boxes.row(i).clone();
        cv::Mat aligned, emb;
        recognizer->alignCrop(im, box, aligned);
        recognizer->feature(aligned, emb);
        if (emb.total() != DIM)
          throw std::runtime_error("Unexpected model embedding dimension");
        cv::normalize(emb, emb);
        Extracted e{};
        std::memcpy(e.embedding.data(), emb.ptr<float>(), DIM * sizeof(float));
        for (float f : e.embedding)
          if (!std::isfinite(f))
            throw std::runtime_error("Invalid face embedding");
        e.box = {box.at<float>(0, 0) / width, box.at<float>(0, 1) / height,
                 box.at<float>(0, 2) / width, box.at<float>(0, 3) / height};
        e.confidence = box.at<float>(0, 14);
        e.crop =
            "views/" + std::to_string(photo) + "-" + std::to_string(i) + ".jpg";
        float x = box.at<float>(0, 0), y = box.at<float>(0, 1),
              w = box.at<float>(0, 2), h = box.at<float>(0, 3);
        int left = std::max(0, int(x - w * .22)),
            top = std::max(0, int(y - h * .22)),
            right = std::min(width, int(x + w * 1.22)),
            bottom = std::min(height, int(y + h * 1.22));
        if (right <= left || bottom <= top)
          continue;
        cv::Mat crop = im(cv::Rect(left, top, right - left, bottom - top));
        cv::Mat out;
        double cs = std::min(1., 256. / std::max(crop.cols, crop.rows));
        cv::resize(crop, out, {}, cs, cs, cv::INTER_AREA);
        if (!cv::imwrite((root / e.crop).string(), out,
                         {cv::IMWRITE_JPEG_QUALITY, 90}))
          throw std::runtime_error("Could not save face crop");
        created.push_back(root / e.crop);
        found.push_back(e);
      }
      im.release();
      std::lock_guard<std::mutex> l(mutex);
      try {
        Transaction tx(db);
        if (index.meta.size() + found.size() > MAX_VIEWS)
          throw std::runtime_error("Maximum face library size reached");
        for (auto &e : found) {
          int64_t face = index.match(e.embedding.data(), photo, threshold());
          if (!face)
            face = db.run("INSERT INTO faces(name) VALUES('')");
          int64_t id = db.run(
              "INSERT INTO views(photo_id,face_id,crop,x,y,w,h,confidence) "
              "VALUES(?,?,?,?,?,?,?,?)",
              {photo, face, e.crop, e.box[0], e.box[1], e.box[2], e.box[3],
               e.confidence});
          db.embedding(id, e.embedding.data(), DIM);
          db.run("UPDATE faces SET cover_view_id=COALESCE(cover_view_id,?) "
                 "WHERE id=?",
                 {id, face});
          index.add(id, e.embedding.data(), {photo, face, false});
        }
        db.run(
            "UPDATE photos SET "
            "status='ready',error='',thumbnail=?,width=?,height=? WHERE id=?",
            {thumbpath, width, height, photo});
        tx.commit();
      } catch (...) {
        index.load(db);
        throw;
      }
      index_dirty = true;
    } catch (const std::exception &e) {
      std::lock_guard<std::mutex> l(mutex);
      auto current = db.query("SELECT status FROM photos WHERE id=?", {photo});
      if (!current.empty() && current[0]["status"] != "ready") {
        for (auto &f : created) {
          std::error_code ec;
          fs::remove(f, ec);
        }
        db.run("UPDATE photos SET status='error',error=? WHERE id=?",
               {std::string(e.what()).substr(0, 400), photo});
      }
      std::cerr << "Photo processing error: " << e.what() << std::endl;
    }
  }
  void run() {
    try {
      initialize();
    } catch (const std::exception &e) {
      std::lock_guard<std::mutex> l(mutex);
      state = "Model setup failed";
      error = e.what();
      std::cerr << error << std::endl;
      return;
    }
    while (!stopping) {
      json p;
      {
        std::unique_lock<std::mutex> l(mutex);
        auto rows = db.query(
            "SELECT * FROM photos WHERE status='queued' ORDER BY id LIMIT 1");
        if (rows.empty()) {
          auto current_time = std::chrono::steady_clock::now();
          if (index_dirty &&
              current_time - last_checkpoint > std::chrono::seconds(30)) {
            index.save(root);
            index_dirty = false;
            last_checkpoint = current_time;
          }
          wake.wait_for(l, std::chrono::seconds(2));
          continue;
        }
        p = rows[0];
        db.run("UPDATE photos SET status='processing' WHERE id=?", {p["id"]});
      }
      process(p);
    }
  }
  int regroup() {
    Index next;
    std::map<int64_t, int64_t> plan;
    std::set<int64_t> used;
    DB::Stmt st(
        db,
        "SELECT v.id,v.photo_id,v.face_id,v.manual,e.vector FROM views v JOIN "
        "embeddings e ON e.view_id=v.id ORDER BY v.manual DESC,v.id",
        json::array());
    int64_t temp = -1;
    while (st.step() == SQLITE_ROW) {
      int64_t id = sqlite3_column_int64(st.s, 0),
              photo = sqlite3_column_int64(st.s, 1),
              old = sqlite3_column_int64(st.s, 2);
      bool manual = sqlite3_column_int(st.s, 3);
      std::array<float, DIM> e;
      std::memcpy(e.data(), sqlite3_column_blob(st.s, 4), sizeof e);
      int64_t face = old;
      if (!manual) {
        face = next.match(e.data(), photo, threshold());
        if (!face)
          face = used.count(old) ? temp-- : old;
      }
      used.insert(face);
      plan[id] = face;
      next.add(id, e.data(), {photo, face, manual});
    }
    Transaction tx(db);
    std::map<int64_t, int64_t> new_ids;
    int changed = 0;
    for (auto &[id, face] : plan) {
      if (face < 0) {
        if (!new_ids.count(face))
          new_ids[face] = db.run("INSERT INTO faces(name) VALUES('')");
        face = new_ids.at(face);
      }
      if (index.meta.at(id).face != face) {
        db.run("UPDATE views SET face_id=? WHERE id=? AND manual=0",
               {face, id});
        changed++;
      }
    }
    db.run("DELETE FROM faces WHERE name='' AND NOT EXISTS(SELECT 1 FROM views "
           "WHERE views.face_id=faces.id)");
    repair_face_covers(db);
    tx.commit();
    index.load(db);
    index.save(root);
    return changed;
  }
};
