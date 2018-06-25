const joinPaths = require('path').join
const express = require('express')
const DPack = require('@dpack/core')
const chalk = require('chalk')
const dpackapi = require('@dpack/api')
const ScopedFS = require('@dbrowser/vfs-wrapper')
const parseRange = require('range-parser')
const mime = require('../mime')
const metrics = require('../metrics')
const directoryListingPage = require('../directory-listing-page')

var activeDPacks = {}

module.exports.start = function (vhostCfg, config) {
  var server = express()

  // start the dpack
  if (!activeDPacks[vhostCfg.id]) {
    DPack(vhostCfg.storageDirectory, {key: vhostCfg.dPackKey}, (err, dpack) => {
      if (err) {
        throw err
      }
      dpack.joinNetwork()
      activeDPacks[vhostCfg.id] = dpack
      metrics.trackDPackStats(dpack, vhostCfg)
    })
  }

  // setup the server routes
  server.use(metrics.hits(vhostCfg))
  server.use(metrics.respTime(vhostCfg))
  server.get('/.well-known/dpack', function (req, res) {
    res.status(200).end('dweb://' + vhostCfg.dPackKey + '/\nTTL=3600')
  })
  if (!config.httpMirror) {
    server.get('*', function (req, res) {
      res.redirect('dweb://' + vhostCfg.hostnames[0] + req.url)
    })
  } else {
    server.use(createHttpMirror(vhostCfg))
  }

  // log
  console.log(`${chalk.bold(`Serving`)}
  ${vhostCfg.url}
  ${chalk.dim(`at`)} ${vhostCfg.hostnames.join(', ')}`)

  return server
}

module.exports.stop = function (vhostCfg) {
  if (activeDPacks[vhostCfg.id]) {
    activeDPacks[vhostCfg.id].close()
    activeDPacks[vhostCfg.id] = null
  }

  // log
  console.log(`${chalk.bold(`Stopped serving`)} ${vhostCfg.url}`)
}

// internal methods
// =

function createHttpMirror (vhostCfg) {
  return async function (req, res) {
    var respondError = (code, status) => {
      res.status(code)
      res.end(code + ' ' + status)
    }
    var fileReadStream
    var headersSent = false
    var cspHeader = ''

    // validate request
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return respondError(405, 'Method Not Supported')
    }

    // lookup dpack
    var vaultFS = new ScopedFS(vhostCfg.storageDirectory)

    // read the manifest (it's needed in a couple places)
    var manifest
    try { manifest = await dpackapi.readManifest(vaultFS) } catch (e) { manifest = null }

    // read manifest CSP
    if (manifest && manifest.content_security_policy && typeof manifest.content_security_policy === 'string') {
      cspHeader = manifest.content_security_policy
    }

    // lookup entry
    var statusCode = 200
    var entry
    var isFolder = req.path.endsWith('/')
    const tryStat = async (path) => {
      // abort if we've already found it
      if (entry) return
      // apply the web_root config
      if (manifest && manifest.web_root) {
        if (path) {
          path = joinPaths(manifest.web_root, path)
        } else {
          path = manifest.web_root
        }
      }
      // attempt lookup
      try {
        entry = await dpackapi.stat(vaultFS, path)
        entry.path = path
      } catch (e) {}
    }
    // detect if this is a folder without a trailing slash
    if (!isFolder) {
      await tryStat(req.path)
      if (entry && entry.isDirectory()) {
        res.set({Location: `${req.path || ''}/`})
        return res.status(303).end()
      }
    }
    entry = false
    // do actual lookup
    if (isFolder) {
      await tryStat(req.path + 'index.html')
      await tryStat(req.path + 'index.md')
      await tryStat(req.path)
    } else {
      await tryStat(req.path)
      await tryStat(req.path + '.html') // fallback to .html
    }

    // handle folder
    if (entry && entry.isDirectory()) {
      res.set({
        'Content-Type': 'text/html',
        'Content-Security-Policy': cspHeader,
        'Access-Control-Allow-Origin': '*'
      })
      if (req.method === 'HEAD') {
        return res.status(204).end()
      } else {
        return res.status(200).end(await directoryListingPage(vaultFS, req.path, manifest && manifest.web_root))
      }
    }

    // handle not found
    if (!entry) {
      // check for a fallback page
      if (manifest && manifest.fallback_page) {
        await tryStat(manifest.fallback_page)
      }
      if (!entry) {
        return respondError(404, 'File Not Found')
      }
    }

    // handle range
    res.set('Accept-Ranges', 'bytes')
    var range = req.headers.range && parseRange(entry.size, req.headers.range)
    if (range && range.type === 'bytes') {
      range = range[0] // only handle first range given
      statusCode = 206
      res.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + entry.size)
      res.set('Content-Length', range.end - range.start + 1)
    } else {
      if (entry.size) {
        res.set('Content-Length', entry.size)
      }
    }

    // fetch the entry and stream the response
    fileReadStream = vaultFS.createReadStream(entry.path, range)
    var dataStream = fileReadStream
      .pipe(mime.identifyStream(entry.path, mimeType => {
        // cleanup the timeout now, as bytes have begun to stream

        // send headers, now that we can identify the data
        headersSent = true
        res.set({
          'Content-Type': mimeType,
          'Content-Security-Policy': cspHeader,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age: 60'
        })

        if (req.method === 'HEAD') {
          dataStream.destroy() // stop reading data
          res.status(204).end()
        } else {
          res.status(statusCode)
          dataStream.pipe(res)
        }
      }))

    // handle empty files
    fileReadStream.once('end', () => {
      if (!headersSent) {
        res.set({
          'Content-Security-Policy': cspHeader,
          'Access-Control-Allow-Origin': '*'
        })
        res.status(200).end()
      }
    })

    // handle read-stream errors
    fileReadStream.once('error', () => {
      if (!headersSent) respondError(500, 'Failed to read file')
    })
  }
}
