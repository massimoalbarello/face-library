// Standalone scaling and identity-invariant check; no photos or network needed.
#ifdef NDEBUG
#undef NDEBUG
#endif
#include "../src/engine.h"
#include <cassert>
#include <chrono>
#include <random>
int main() {
  Index index;
  std::mt19937 rng(42);
  std::normal_distribution<float> random(0, 1);
  std::vector<std::array<float, DIM>> vectors(10000);
  const auto start = std::chrono::steady_clock::now();
  for (int i=0;i<10000;i++) {
    float norm=0;
    for(auto &v:vectors[i]){v=random(rng);norm+=v*v;}
    for(auto &v:vectors[i])v/=std::sqrt(norm);
    index.add(i+1,vectors[i].data(),{i+1,i+1,false});
  }
  int correct=0;
  for(int i=0;i<10000;i+=10) {
    correct+=index.match(vectors[i].data(),20000+i,.99F)==i+1;
    if(i==0) assert(index.match(vectors[i].data(),i+1,.99F)==0);
  }
  assert(correct==1000);
  std::cout<<"PASS 10,000 vectors, 1,000 exact-identity queries, same-photo exclusion; "
           <<correct<<"/1000 found, "
           <<std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count()<<" s total\n";
}
