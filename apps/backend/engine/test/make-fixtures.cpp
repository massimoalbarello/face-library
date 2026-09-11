#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <filesystem>
#include <iostream>
int main(int argc, char **argv) {
  if (argc != 2) { std::cerr << "Usage: make-fixtures DIRECTORY\n"; return 1; }
  std::filesystem::path dir = argv[1];
  cv::Mat a = cv::imread((dir / "lena.jpg").string());
  cv::Mat b = cv::imread((dir / "messi.jpg").string());
  if (a.empty() || b.empty()) { std::cerr << "Download the OpenCV samples first\n"; return 1; }
  cv::Mat darker;
  a.convertTo(darker, -1, 0.8);
  cv::imwrite((dir / "lena-darker.jpg").string(), darker);
  cv::Mat canvas(512, 1024, CV_8UC3, cv::Scalar(255, 255, 255));
  cv::resize(a, a, {512, 512});
  a.copyTo(canvas(cv::Rect(0, 0, a.cols, a.rows)));
  double scale = std::min(512. / b.cols, 512. / b.rows);
  cv::resize(b, b, {}, scale, scale);
  b.copyTo(canvas(cv::Rect(512, 0, b.cols, b.rows)));
  cv::imwrite((dir / "two-people.jpg").string(), canvas);
  cv::Mat blank(400, 500, CV_8UC3, cv::Scalar(229, 237, 233));
  cv::imwrite((dir / "no-face.png").string(), blank);
}
