const crypto = require('crypto')
const express = require('express')
const bodyParser = require('http-body-parser').express
const {validateDPackCfg, getDPackKey} = require('./config')

var sessions = new Set()

module.exports.create = function (config) {
  var server = express()
  server.use(bodyParser({enableTypes: ['json']}))

  // jeff sessions management
  // =

  function validateSession (req, res, next) {
    var auth = req.headers.authorization
    if (auth && auth.startsWith('Bearer ')) {
      let sessionToken = auth.slice('Bearer '.length)
      if (sessions.has(sessionToken)) {
        // session is valid
        res.locals.sessionToken = sessionToken
        return next()
      }
    }
    // invalid session
    res.status(401).json({message: 'You must sign in to access this resource.'})
  }

  // routes
  // =

  server.get('/.well-known/psa', (req, res) => {
    res.json({
      PSA: 1,
      title: 'My dPack Forever Service',
      description: 'Keep your DPacks online!',
      links: [{
        rel: 'https://vault.org/services/purl/purl/dweb/spec/dpack-api',
        title: 'dPack Accounts API',
        href: '/v1/accounts'
      }, {
        rel: 'https://vault.org/services/purl/purl/dweb/spec/dpack-api',
        title: 'dPack API',
        href: '/v1/dpacks'
      }]
    })
  })

  server.post('/v1/accounts/login', (req, res) => {
    if (!(req.body.username === config.webapi.username && req.body.password === config.webapi.password)) {
      return res.status(403).json({message: 'Invalid username or password.'})
    }
    let sessionToken = crypto.randomBytes(32).toString('base64')
    sessions.add(sessionToken)
    res.json({sessionToken})
  })

  server.post('/v1/accounts/logout', validateSession, (req, res) => {
    sessions.delete(res.locals.sessionToken)
    res.status(200).end()
  })

  server.get('/v1/accounts/account', validateSession, (req, res) => {
    res.json({
      username: config.webapi.username
    })
  })

  server.get('/v1/dpacks', validateSession, (req, res) => {
    res.json({
      items: config.dpacks.map(dpackCfg => ({
        url: `dweb://${dpackCfg.dPackKey}/`,
        name: dpackCfg.name,
        additionalUrls: dpackCfg.additionalUrls
      }))
    })
  })

  server.post('/v1/dpacks/add', validateSession, (req, res) => {
    // extract config
    var dpackCfg = {url: req.body.url}
    if (req.body.name) dpackCfg.name = req.body.name
    if (req.body.domains) dpackCfg.otherDomains = req.body.domains // small diff between our config format and the pinning api spec

    // validate
    try {
      validateDPackCfg(dpackCfg)
    } catch (e) {
      let message = 'There were errors in your request.'
      if (e.invalidUrl) message = `Invalid DPack url (${e.value}). Must provide the url of the DPack you wish to pin.`
      if (e.invalidName) message = `Invalid name (${e.value}). Must provide a name for the DPack.`
      if (e.invalidDomain) message = `Invalid domain (${e.value}).`
      return res.status(422).json({message})
    }

    // add to config
    config.addDPack(dpackCfg)
    res.status(200).end()
  })

  server.post('/v1/dpacks/remove', validateSession, (req, res) => {
    // validate
    var dPackKey
    try {
      dPackKey = getDPackKey(req.body.url)
      if (!dPackKey) throw new Error()
    } catch (e) {
      res.status(422).json({message: `Invalid DPack url (${req.body.url}). Must provide the url of the DPack you wish to unpin.`})
    }

    // remove from config
    config.removeDPack(dPackKey)
    res.status(200).end()
  })

  server.get('/v1/dpacks/item/:key', validateSession, (req, res) => {
    var dpackCfg = config.dpacks.find(d => d.dPackKey === req.params.key)
    if (!dpackCfg) {
      return res.status(404).json({message: 'DPack not found'})
    }
    return res.json({
      url: `dweb://${dpackCfg.dPackKey}/`,
      name: dpackCfg.name,
      additionalUrls: dpackCfg.additionalUrls
    })
  })

  server.post('/v1/dpacks/item/:key', validateSession, (req, res) => {
    // extract config
    var dpackCfg = {
      url: `dweb://${req.params.key}/`,
      name: req.body.name,
      otherDomains: req.body.domains // small diff between our config format and the pinning api spec
    }

    // find the old dPack
    var oldDPackCfg = config.canonical.dpacks.find(d => getDPackKey(d.url) === req.params.key)
    if (!oldDPackCfg) {
      return res.status(404).json({message: 'DPack not found'})
    }

    // fill in missing attrs
    if (typeof dpackCfg.name === 'undefined') dpackCfg.name = oldDPackCfg.name
    if (typeof dpackCfg.otherDomains === 'undefined') dpackCfg.otherDomains = oldDPackCfg.otherDomains

    // validate
    try {
      validateDPackCfg(dpackCfg)
    } catch (e) {
      let message = 'There were errors in your request.'
      if (e.invalidUrl) message = `Invalid DPack url (${e.value}). Must provide the url of the DPack you wish to pin.`
      if (e.invalidName) message = `Invalid name (${e.value}). Must provide a name for the DPack.`
      if (e.invalidDomain) message = `Invalid domain (${e.value}).`
      return res.status(422).json({message})
    }

    // update the config
    config.updateDPack(req.params.key, dpackCfg)
    res.status(200).end()
  })

  return server
}
