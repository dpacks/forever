var prom = require('prom-client')
var responseTime = require('response-time')

var metric = {
  https_hits: new prom.Counter({name: 'app_https_hits', help: 'Number of https requests received', labelNames: ['hostname', 'path']}),
  respTime: new prom.Summary({name: 'app_https_response_time_ms', help: 'Response time in ms', labelNames: ['hostname', 'path']}),
  dpackUploadSpeed: new prom.Gauge({name: 'app_dpack_upload_speed', help: 'Bytes uploaded per second', labelNames: ['dpack']}),
  dpackDownloadSpeed: new prom.Gauge({name: 'app_dpack_download_speed', help: 'Bytes downloaded per second', labelNames: ['dpack']}),
  dWebPeers: new prom.Gauge({name: 'app_dweb_peers', help: 'Number of peers on the dWeb network', labelNames: ['dweb']})
}

module.exports = {hits: hits, respTime: respTime, trackDPackStats: trackDPackStats, getMetrics: getMetrics}

function hits (vhostCfg) {
  return function (req, res, next) {
    metric.https_hits.inc({hostname: vhostCfg.id, path: req.path})

    next()
  }
}

function respTime (vhostCfg) {
  return responseTime(function (req, res, time) {
    metric.respTime.labels(vhostCfg.id, req.path).observe(time)
  })
}

function trackDPackStats (dpack, vhostCfg) {
  var stats = dpack.trackStats()
  setInterval(function () {
    metric.dpackUploadSpeed.labels(vhostCfg.id).set(stats.network.uploadSpeed)
    metric.dpackDownloadSpeed.labels(vhostCfg.id).set(stats.network.downloadSpeed)
    if (typeof stats.peers === 'number') {
      metric.dWebPeers.labels(vhostCfg.id).set(stats.peers.total || 0)
    }
  }, 500)
}

function getMetrics () {
  return prom.register.metrics()
}
