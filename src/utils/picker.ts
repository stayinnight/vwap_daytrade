
export function createBatchPicker(arr: any[], batchSize = 5) {
  if (!Array.isArray(arr) || arr.length < batchSize) {
    throw new Error('数组长度必须大于等于 batchSize');
  }

  let index = 0; // 当前游标

  return function nextBatch() {
    const result = [];

    for (let i = 0; i < batchSize; i++) {
      const pos = (index + i) % arr.length;
      result.push(arr[pos]);
    }

    index += batchSize;
    return result;
  };
}
