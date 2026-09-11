#pragma once
#include <algorithm>
#include <cmath>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/objdetect.hpp>
#if CV_VERSION_MAJOR >= 5
#include <opencv2/geometry.hpp>
#endif
#include <vector>

// YuNet detects upright faces. Sweep the image through bounded orientations,
// then return boxes AND all five landmarks in the original image coordinates.
// SFace can therefore align the original pixels without changing its
// embeddings.
inline cv::Mat detect_oriented_faces(const cv::Mat &image,
                                     cv::Ptr<cv::FaceDetectorYN> detector,
                                     bool orientations = true) {
  cv::Mat small;
  const double scale = std::min(1., 640. / std::max(image.cols, image.rows));
  cv::resize(image, small, {}, scale, scale, cv::INTER_AREA);
  const double sx = double(image.cols) / small.cols;
  const double sy = double(image.rows) / small.rows;
  std::vector<cv::Mat> candidates;
  for (int angle : {0, 90, -90, 180, 45, -45, 135, -135}) {
    if (angle && !orientations)
      break;
    cv::Mat input, inverse;
    if (!angle) {
      input = small;
      inverse = cv::Mat::eye(2, 3, CV_64F);
    } else {
      const double rad = angle * CV_PI / 180.;
      const double width = std::abs(std::cos(rad)) * small.cols +
                           std::abs(std::sin(rad)) * small.rows;
      const double height = std::abs(std::sin(rad)) * small.cols +
                            std::abs(std::cos(rad)) * small.rows;
      const double fit = std::min(1., 640. / std::max(width, height));
      const cv::Size size(std::max(1, int(std::ceil(width * fit))),
                          std::max(1, int(std::ceil(height * fit))));
      cv::Mat rotation = cv::getRotationMatrix2D(
          {small.cols / 2.f, small.rows / 2.f}, angle, fit);
      rotation.at<double>(0, 2) += size.width / 2. - small.cols / 2.;
      rotation.at<double>(1, 2) += size.height / 2. - small.rows / 2.;
      cv::warpAffine(small, input, rotation, size, cv::INTER_LINEAR,
                     cv::BORDER_CONSTANT);
      cv::invertAffineTransform(rotation, inverse);
    }
    cv::Mat found;
    detector->setInputSize(input.size());
    detector->detect(input, found);
    auto original = [&](double x, double y) {
      return cv::Point2f(
          (inverse.at<double>(0, 0) * x + inverse.at<double>(0, 1) * y +
           inverse.at<double>(0, 2)) *
              sx,
          (inverse.at<double>(1, 0) * x + inverse.at<double>(1, 1) * y +
           inverse.at<double>(1, 2)) *
              sy);
    };
    for (int row = 0; row < found.rows; row++) {
      cv::Mat box = found.row(row).clone();
      const float x = box.at<float>(0, 0), y = box.at<float>(0, 1);
      const float w = box.at<float>(0, 2), h = box.at<float>(0, 3);
      const auto center = original(x + w / 2, y + h / 2);
      if (center.x < 0 || center.y < 0 || center.x >= image.cols ||
          center.y >= image.rows)
        continue;
      std::vector<cv::Point2f> corners = {original(x, y), original(x + w, y),
                                          original(x, y + h),
                                          original(x + w, y + h)};
      float left = image.cols, top = image.rows, right = 0, bottom = 0;
      for (auto p : corners) {
        left = std::min(left, p.x);
        top = std::min(top, p.y);
        right = std::max(right, p.x);
        bottom = std::max(bottom, p.y);
      }
      left = std::max(0.f, left);
      top = std::max(0.f, top);
      right = std::min(float(image.cols), right);
      bottom = std::min(float(image.rows), bottom);
      if (right <= left || bottom <= top)
        continue;
      box.at<float>(0, 0) = left;
      box.at<float>(0, 1) = top;
      box.at<float>(0, 2) = right - left;
      box.at<float>(0, 3) = bottom - top;
      for (int i = 4; i < 14; i += 2) {
        const auto landmark =
            original(box.at<float>(0, i), box.at<float>(0, i + 1));
        box.at<float>(0, i) = landmark.x;
        box.at<float>(0, i + 1) = landmark.y;
      }
      candidates.push_back(box);
    }
  }
  std::stable_sort(candidates.begin(), candidates.end(),
                   [](const cv::Mat &a, const cv::Mat &b) {
                     return a.at<float>(0, 14) > b.at<float>(0, 14);
                   });
  cv::Mat result;
  std::vector<cv::Rect2f> accepted;
  for (const auto &box : candidates) {
    const cv::Rect2f rect(box.at<float>(0, 0), box.at<float>(0, 1),
                          box.at<float>(0, 2), box.at<float>(0, 3));
    bool duplicate = false;
    for (const auto &other : accepted) {
      const float area = (rect & other).area();
      if (area / (rect.area() + other.area() - area) > .35f) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      accepted.push_back(rect);
      result.push_back(box);
    }
  }
  return result;
}
