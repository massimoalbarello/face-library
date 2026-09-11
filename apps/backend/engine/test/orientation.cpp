#include "../src/detection.h"
#include <chrono>
#include <filesystem>
#include <iostream>
#include <opencv2/imgcodecs.hpp>
#include <stdexcept>
namespace fs = std::filesystem;
int main(int argc, char **argv) {
  if (argc < 4) {
    std::cerr << "Usage: orientation-test MODELS FACE_IMAGE OUTPUT_DIR "
                 "[SCREENSHOT]\n";
    return 1;
  }
  try {
    cv::setNumThreads(1);
    auto detector =
        cv::FaceDetectorYN::create((fs::path(argv[1]) / "yunet.onnx").string(),
                                   "", {640, 640}, .85, .3, 1000);
    auto recognizer = cv::FaceRecognizerSF::create(
        (fs::path(argv[1]) / "sface.onnx").string(), "");
    cv::Mat original = cv::imread(argv[2]);
    if (original.empty())
      throw std::runtime_error("Missing image");
    fs::create_directories(argv[3]);
    cv::Mat reference;
    int recovered = 0;
    auto start = std::chrono::steady_clock::now();
    for (int angle :
         {0, 15, 30, 45, 60, 75, 90, 135, 180, -15, -30, -45, -60, -90, -135}) {
      int side = int(std::ceil(std::hypot(original.cols, original.rows)));
      auto rotation = cv::getRotationMatrix2D(
          {original.cols / 2.f, original.rows / 2.f}, angle, 1);
      rotation.at<double>(0, 2) += (side - original.cols) / 2.;
      rotation.at<double>(1, 2) += (side - original.rows) / 2.;
      cv::Mat photo;
      cv::warpAffine(original, photo, rotation, {side, side});
      auto old = detect_oriented_faces(photo, detector, false);
      auto faces = detect_oriented_faces(photo, detector);
      if (faces.rows != 1)
        throw std::runtime_error("Expected one deduplicated face at angle " +
                                 std::to_string(angle) + ", got " +
                                 std::to_string(faces.rows));
      cv::Mat aligned, embedding;
      recognizer->alignCrop(photo, faces.row(0), aligned);
      recognizer->feature(aligned, embedding);
      cv::normalize(embedding, embedding);
      if (angle == 0)
        reference = embedding.clone();
      double score = reference.dot(embedding);
      std::cout << "angle=" << angle << " baseline=" << old.rows
                << " oriented=" << faces.rows << " cosine=" << score
                << std::endl;
      if (score < .363)
        throw std::runtime_error(
            "Rotated face no longer matches its upright embedding");
      if (old.rows == 0)
        recovered++;
      cv::imwrite(
          (fs::path(argv[3]) / ("tilt-" + std::to_string(angle) + ".jpg"))
              .string(),
          photo);
    }
    cv::Mat mixed(original.rows, original.cols * 2, CV_8UC3);
    original.copyTo(mixed(cv::Rect(0, 0, original.cols, original.rows)));
    cv::Mat sideways;
    cv::rotate(original, sideways, cv::ROTATE_90_CLOCKWISE);
    cv::resize(sideways, sideways, original.size());
    sideways.copyTo(
        mixed(cv::Rect(original.cols, 0, original.cols, original.rows)));
    if (detect_oriented_faces(mixed, detector).rows != 2)
      throw std::runtime_error(
          "Mixed upright/sideways detections were merged or missed");
    cv::imwrite((fs::path(argv[3]) / "mixed-orientations.jpg").string(), mixed);
    cv::Mat blank(640, 640, CV_8UC3, cv::Scalar(230, 230, 230));
    if (detect_oriented_faces(blank, detector).rows)
      throw std::runtime_error("False positive on blank input");
    if (argc > 4) {
      cv::Mat screen = cv::imread(argv[4]);
      auto tile =
          screen(cv::Rect(int(screen.cols * .76), int(screen.rows * .072),
                          int(screen.cols * .235), int(screen.rows * .30)))
              .clone();
      auto old = detect_oriented_faces(tile, detector, false),
           faces = detect_oriented_faces(tile, detector);
      std::cout << "Attached tilted example: baseline=" << old.rows
                << ", oriented=" << faces.rows << std::endl;
      if (faces.rows != 1)
        throw std::runtime_error("Tilted screenshot face was not recovered");
      cv::imwrite((fs::path(argv[3]) / "attached-tilted-example.jpg").string(),
                  tile);
    }
    std::cout << "PASS: 15 rotations, embeddings, mixed orientations, blank "
                 "input; recovered "
              << recovered << " missed rotations in "
              << std::chrono::duration<double>(
                     std::chrono::steady_clock::now() - start)
                     .count()
              << "s\n";
  } catch (const std::exception &e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}
