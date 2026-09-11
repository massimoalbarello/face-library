#pragma once
#include "assets.h"
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/sha256.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>
#include <sstream>
#include <stdexcept>
#include <vector>
namespace fs = std::filesystem;
inline std::string hex(const unsigned char *p, size_t n) {
  std::ostringstream s;
  for (size_t i = 0; i < n; i++)
    s << std::hex << std::setw(2) << std::setfill('0') << int(p[i]);
  return s.str();
}
inline std::string digest(const std::string &s) {
  unsigned char out[32];
  if (mbedtls_sha256((const unsigned char *)s.data(), s.size(), out, 0))
    throw std::runtime_error("Hash failed");
  return hex(out, 32);
}
inline std::string file_hash(const fs::path &p) {
  std::ifstream f(p, std::ios::binary);
  if (!f)
    return "";
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  char b[65536];
  while (f.read(b, sizeof b) || f.gcount())
    mbedtls_sha256_update(&ctx, (const unsigned char *)b, f.gcount());
  unsigned char out[32];
  mbedtls_sha256_finish(&ctx, out);
  mbedtls_sha256_free(&ctx);
  return hex(out, 32);
}
inline std::string random_hex(size_t n = 32) {
  std::vector<unsigned char> b(n);
  std::ifstream f("/dev/urandom", std::ios::binary);
  if (!f.read((char *)b.data(), b.size()))
    throw std::runtime_error("Random source unavailable");
  return hex(b.data(), b.size());
}
inline bool equal_secret(const std::string &a, const std::string &b) {
  if (a.size() != b.size())
    return false;
  unsigned char v = 0;
  for (size_t i = 0; i < a.size(); i++)
    v |= a[i] ^ b[i];
  return v == 0;
}
inline std::string read_file(const fs::path &p) {
  std::ifstream f(p, std::ios::binary);
  if (!f)
    throw std::runtime_error("File unavailable");
  return {std::istreambuf_iterator<char>(f), {}};
}
inline void write_file(const fs::path &p, const std::string &s) {
  auto t = p.string() + ".tmp";
  std::ofstream f(t, std::ios::binary);
  f.write(s.data(), s.size());
  f.close();
  if (!f)
    throw std::runtime_error("Unable to save file; check disk space");
  fs::rename(t, p);
}
struct TLS {
  mbedtls_net_context net;
  mbedtls_ssl_context ssl;
  mbedtls_ssl_config cfg;
  mbedtls_x509_crt ca;
  mbedtls_entropy_context entropy;
  mbedtls_ctr_drbg_context rng;
  TLS() {
    mbedtls_net_init(&net);
    mbedtls_ssl_init(&ssl);
    mbedtls_ssl_config_init(&cfg);
    mbedtls_x509_crt_init(&ca);
    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&rng);
  }
  ~TLS() {
    mbedtls_net_free(&net);
    mbedtls_ssl_free(&ssl);
    mbedtls_ssl_config_free(&cfg);
    mbedtls_x509_crt_free(&ca);
    mbedtls_ctr_drbg_free(&rng);
    mbedtls_entropy_free(&entropy);
  }
};
// Model downloads are fixed HTTPS URLs and verified against pinned SHA-256
// hashes.
inline void download_model(const std::string &path, const fs::path &dest,
                           const std::string &sha, size_t max_bytes) {
  if (fs::exists(dest) && file_hash(dest) == sha)
    return;
  TLS t;
  auto check = [](int n) {
    if (n < 0)
      throw std::runtime_error("Secure model download failed (" +
                               std::to_string(n) + ")");
  };
  check(mbedtls_ctr_drbg_seed(&t.rng, mbedtls_entropy_func, &t.entropy, nullptr,
                              0));
  check(mbedtls_x509_crt_parse(&t.ca, (const unsigned char *)CACERT,
                               sizeof CACERT));
  check(mbedtls_ssl_config_defaults(&t.cfg, MBEDTLS_SSL_IS_CLIENT,
                                    MBEDTLS_SSL_TRANSPORT_STREAM,
                                    MBEDTLS_SSL_PRESET_DEFAULT));
  mbedtls_ssl_conf_authmode(&t.cfg, MBEDTLS_SSL_VERIFY_REQUIRED);
  mbedtls_ssl_conf_ca_chain(&t.cfg, &t.ca, nullptr);
  mbedtls_ssl_conf_rng(&t.cfg, mbedtls_ctr_drbg_random, &t.rng);
  mbedtls_ssl_conf_read_timeout(&t.cfg, 60000);
  check(mbedtls_ssl_setup(&t.ssl, &t.cfg));
  check(mbedtls_ssl_set_hostname(&t.ssl, "media.githubusercontent.com"));
  check(mbedtls_net_connect(&t.net, "media.githubusercontent.com", "443",
                            MBEDTLS_NET_PROTO_TCP));
  mbedtls_ssl_set_bio(&t.ssl, &t.net, mbedtls_net_send, mbedtls_net_recv,
                      mbedtls_net_recv_timeout);
  check(mbedtls_ssl_handshake(&t.ssl));
  if (mbedtls_ssl_get_verify_result(&t.ssl))
    throw std::runtime_error("Model server certificate invalid");
  std::string req =
      "GET " + path +
      " HTTP/1.1\r\nHost: media.githubusercontent.com\r\nUser-Agent: "
      "face-library/1\r\nAccept-Encoding: identity\r\nConnection: "
      "close\r\n\r\n";
  for (size_t i = 0; i < req.size();) {
    int n = mbedtls_ssl_write(&t.ssl, (const unsigned char *)req.data() + i,
                              req.size() - i);
    check(n);
    if (!n)
      throw std::runtime_error("Download connection closed");
    i += n;
  }
  auto tmp = dest.string() + ".download";
  std::ofstream out(tmp, std::ios::binary);
  std::string header;
  size_t total = 0;
  bool body = false;
  unsigned char buf[16384];
  try {
    for (;;) {
      int n = mbedtls_ssl_read(&t.ssl, buf, sizeof buf);
      if (n == 0 || n == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY)
        break;
      check(n);
      if (!body) {
        header.append((char *)buf, n);
        auto pos = header.find("\r\n\r\n");
        if (pos == std::string::npos) {
          if (header.size() > 32768)
            throw std::runtime_error("Invalid model response");
          continue;
        }
        if (header.rfind("HTTP/1.1 200", 0) != 0 &&
            header.rfind("HTTP/1.0 200", 0) != 0)
          throw std::runtime_error("Model server did not return 200");
        auto payload = header.substr(pos + 4);
        out.write(payload.data(), payload.size());
        total += payload.size();
        header.clear();
        body = true;
      } else {
        out.write((char *)buf, n);
        total += n;
      }
      if (total > max_bytes || !out)
        throw std::runtime_error("Model download exceeded limit or disk full");
    }
    out.close();
    if (!body || file_hash(tmp) != sha)
      throw std::runtime_error("Model checksum mismatch");
    fs::rename(tmp, dest);
  } catch (...) {
    out.close();
    fs::remove(tmp);
    throw;
  }
}
