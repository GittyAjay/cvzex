const promise1 = new Promise((res, rej) => {
  res('sucess');
});
const promise2 = new Promise((res, rej) => {
  rej('Failur2');
});
const promise3 = new Promise((res, rej) => {
  res('sucess');
});
(async () => {
  try {
    const res = await Promise.allSettled([promise1, promise2, promise3]);
    console.log('result', res);
  } catch (err) {
    console.log('err', err);
  }
})();
