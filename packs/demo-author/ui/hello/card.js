/* 演示两种能力：读本包配置 + 调宿主服务 */
(function () {
  var $ = function (id) { return shadowRoot.getElementById(id) }
  var out = $('out')
  var btn = $('ping')
  if (!btn) return
  btn.addEventListener('click', function () {
    btn.disabled = true
    if (out) out.textContent = '读取中…'
    // ① 读本扩展配置（settings 卡默认走 profile 级）
    qqbotExt.getConfig().then(function (cfg) {
      var n = Object.keys(cfg || {}).length
      // ② 问一下宿主有哪些服务（宿主全能力，走白名单 RPC）
      return Promise.resolve(qqbotExt.kernel.has('workingDirectory')).then(function (hasWd) {
        if (out) {
          out.textContent = '配置项 ' + n + ' 个 · 宿主服务 workingDirectory: ' + (hasWd ? '有' : '无')
        }
      })
    }).catch(function (e) {
      if (out) out.textContent = '异常: ' + e
    }).then(function () { btn.disabled = false })
  })
})();
