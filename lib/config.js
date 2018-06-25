/**

Forever config

The main source of truth for homebase's config is the yaml file.
The user can change that yaml during operation and homebase will reload it and run the changes.

The user can also modify the active config using web apis.
In that case, we need to serialize the change back into the yaml file.
So that we change as little as possible, we maintain the values as given by the user ('canonical').
That way, when we write back to the yaml file, we don't write back a bunch of defaults.

The structure of this is the ForeverConfig classes which wrap canonical.
They use getters to provide computed info and defaults.

NOTE: we should *not* modify config to avoid writing those edits back to the yaml!

*/

const os = require('os')
const path = require('path')
const fs = require('fs')
const EventEmitter = require('events')
const yaml = require('js-yaml')
const untildify = require('untildify')
const isDomain = require('is-domain-name')
const isOrigin = require('is-http-url')
const _flatten = require('lodash.flatten')
const {ConfigError} = require('./errors')

const DEFAULT_CONFIG_DIRECTORY = path.join(os.homedir(), '.forever')
const IS_DEBUG = (['debug', 'staging', 'test'].indexOf(process.env.NODE_ENV) !== -1)

// exported api
// =

class ForeverConfig {
  constructor (configPath = false) {
    this.events = new EventEmitter()

    // where the config is loaded from
    this.configPath = null

    // `canonical` the canonical config
    // - reflects *only* the values that users set
    // - first read from the yaml file
    // - can then be updated by APIs
    // - *may* be slightly massaged so long as it won't annoy users
    this.canonical = {}

    if (configPath) {
      this.readFromFile(configPath)
    }
  }

  readFromFile (configPath = false) {
    configPath = configPath || this.configPath
    this.configPath = configPath
    var configContents

    // read file
    try {
      configContents = fs.readFileSync(configPath, 'utf8')
    } catch (e) {
      // throw if other than a not-found
      configContents = ''
      if (e.code !== 'ENOENT') {
        console.error('Failed to load config file at', configPath)
        throw e
      }
    }

    // parse
    try {
      this.canonical = yaml.safeLoad(configContents)
    } catch (e) {
      console.error('Failed to parse config file at', configPath)
      throw e
    }
    this.canonical = this.canonical || {}

    // validate
    validate(this.canonical)

    this.events.emit('read-config')
  }

  writeToFile (configPath = false) {
    configPath = configPath || this.configPath
    fs.writeFileSync(configPath, yaml.safeDump(this.canonical, {skipInvalid: true}))
    this.events.emit('wrote-config')
  }

  addDPack (dpackCfg) {
    // make sure it doesnt already exist
    var dPackKey = getDPackKey(dpackCfg.url)
    var oldDPackCfg = this.canonical.dpacks.find(d => getDPackKey(d.url) === dPackKey)
    if (oldDPackCfg) return
    // add
    this.canonical.dpacks.push(dpackCfg)
    // write
    this.writeToFile()
  }

  updateDPack (dPackKey, dpackCfg) {
    // find the old
    var oldDPackCfg = this.canonical.dpacks.find(d => getDPackKey(d.url) === dPackKey)
    if (!oldDPackCfg) return
    // update
    oldDPackCfg.url = dpackCfg.url
    if (dpackCfg.otherDomains) {
      oldDPackCfg.otherDomains = dpackCfg.otherDomains
    } else {
      delete oldDPackCfg.otherDomains
    }
    // write
    this.writeToFile()
  }

  removeDPack (dPackKey) {
    // remove
    this.canonical.dpacks = this.canonical.dpacks.filter(d => getDPackKey(d.url) !== dPackKey)
    // write
    this.writeToFile()
  }

  get directory () {
    return untildify(this.canonical.directory || DEFAULT_CONFIG_DIRECTORY)
  }

  get domain () {
    if (!IS_DEBUG && !this.canonical.domain) {
      // only fallback to hostname if not debugging, otherwise tests will always fail
      return os.hostname()
    }
    return this.canonical.domain
  }

  get httpMirror () {
    return this.canonical.httpMirror || false
  }

  get ports () {
    var ports = this.canonical.ports || {}
    ports.http = ports.http || 80
    ports.https = ports.https || 443
    return ports
  }

  get letsencrypt () {
    return this.canonical.letsencrypt || false
  }

  get dashboard () {
    return this.canonical.dashboard || false
  }

  get webapi () {
    return this.canonical.webapi || false
  }

  get dpacks () {
    return this.canonical.dpacks ? this.canonical.dpacks.map(v => new ForeverDPackConfig(v, this)) : []
  }

  get proxies () {
    return this.canonical.proxies ? this.canonical.proxies.map(v => new ForeverProxyConfig(v, this)) : []
  }

  get redirects () {
    return this.canonical.redirects ? this.canonical.redirects.map(v => new ForeverRedirectConfig(v, this)) : []
  }

  get allVhosts () {
    return this.dpacks.concat(this.proxies).concat(this.redirects)
  }

  get hostnames () {
    return [this.domain].concat(_flatten(this.allVhosts.map(vhostCfg => vhostCfg.hostnames)))
  }
}

class ForeverDPackConfig {
  constructor (canonical, config) {
    for (var k in canonical) {
      this[k] = canonical[k]
    }
    this.config = config
  }

  get id () {
    return 'dpack-' + this.dPackKey
  }

  get vhostType () {
    return 'dweb'
  }

  get dPackKey () {
    return getDPackKey(this.url)
  }

  get hostnames () {
    return [`${this.name}.${this.config.domain}`].concat(this.otherDomains || [])
  }

  get additionalUrls () {
    var urls = []
    this.hostnames.forEach(hostname => {
      urls.push('dweb://' + hostname)
      if (this.config.httpMirror) {
        urls.push('https://' + hostname)
      }
    })
    return urls
  }

  get storageDirectory () {
    return path.join(this.config.directory, this.dPackKey)
  }
}

class ForeverProxyConfig {
  constructor (canonical, config) {
    for (var k in canonical) {
      this[k] = canonical[k]
    }
  }

  get id () {
    return 'proxy-' + this.from
  }

  get vhostType () {
    return 'proxy'
  }

  get hostnames () {
    return [this.from]
  }
}

class ForeverRedirectConfig {
  constructor (canonical, config) {
    for (var k in canonical) {
      this[k] = canonical[k]
    }
  }

  get id () {
    return 'redirect-' + this.from
  }

  get vhostType () {
    return 'redirect'
  }

  get hostnames () {
    return [this.from]
  }
}

function getDPackKey (url) {
  return /^(dweb:\/\/)?([0-9a-f]{64})\/?$/i.exec(url)[2]
}

function validateDPackCfg (dpack) {
  dpack.otherDomains = (!dpack.otherDomains || Array.isArray(dpack.otherDomains)) ? dpack.otherDomains : [dpack.otherDomains]
  check(dpack && typeof dpack === 'object', 'dpacks.* must be an object, see https://docs.dpack.io/forever#dpacks', dpack)
  check(isDWebUrl(dpack.url), 'dpacks.*.url must be a valid dpack url, see https://docs.dpack.io/forever#dpacksurl', dpack.url, 'invalidUrl')
  check(typeof dpack.name === 'string', 'dpacks.*.name must be specified, see https://docs.dpack.io/forever#dpacksname', dpack.name, 'invalidName')
  if (dpack.otherDomains) {
    dpack.otherDomains.forEach(domain => {
      check(isDomain(domain), 'dpacks.*.otherDomains.* must be domain names, see https://docs.dpack.io/forever#dpacksotherdomains', domain, 'invalidDomain')
    })
  }
}

module.exports = {
  ForeverConfig,
  ForeverDPackConfig,
  ForeverProxyConfig,
  ForeverRedirectConfig,
  validateDPackCfg,
  getDPackKey
}

// internal methods
// =

function validate (config) {
  if ('directory' in config) check(typeof config.directory === 'string', 'directory must be a string, see https://docs.dpack.io/forever#directory')
  if ('domain' in config) check(typeof config.domain === 'string', 'domain must be a string, see https://docs.dpack.io/forever#domain')
  if ('httpMirror' in config) check(typeof config.httpMirror === 'boolean', 'httpMirror must be true or false, see https://docs.dpack.io/forever#httpmirror')
  if ('ports' in config) check(config.ports && typeof config.ports === 'object', 'ports must be an object containing .http and/or .https, see https://docs.dpack.io/forever#ports')
  if ('ports' in config && 'http' in config.ports) check(typeof config.ports.http === 'number', 'ports.http must be a number, see https://docs.dpack.io/forever#portshttp')
  if ('ports' in config && 'https' in config.ports) check(typeof config.ports.https === 'number', 'ports.https must be a number, see https://docs.dpack.io/forever#portshttp')
  if ('letsencrypt' in config) check(typeof config.letsencrypt === 'object' || config.letsencrypt === false, 'letsencrypt must be an object or false, see https://docs.dpack.io/forever#letsencrypt')
  if (config.letsencrypt) check(typeof config.letsencrypt.email === 'string', 'letsencrypt.email must be specified, see https://docs.dpack.io/forever#letsencryptemail')
  if (config.letsencrypt) check(config.letsencrypt.agreeTos === true, 'letsencrypt.agreeTos must be true (you must agree to the Lets Encrypt terms of service) see https://docs.dpack.io/forever#letsencryptagreetos')
  if ('dashboard' in config) check(typeof config.dashboard === 'object' || config.dashboard === false, 'dashboard must be an object or false, see https://docs.dpack.io/forever#dashboard')
  if (config.dashboard && 'port' in config.dashboard) check(typeof config.dashboard.port === 'number', 'dashboard.port must be a number, see https://docs.dpack.io/forever#dashboardport')
  if ('webapi' in config) check(typeof config.webapi === 'object' || config.webapi === false, 'webapi must be an object or false, see https://docs.dpack.io/forever#webapi')
  if (config.webapi) check(typeof config.webapi.username === 'string', 'webapi.username must be specified, see https://docs.dpack.io/forever#webapiusername')
  if (config.webapi) check(typeof config.webapi.password === 'string', 'webapi.password must be specified, see https://docs.dpack.io/forever#webapipassword')
  if (config.dpacks) {
    config.dpacks = Array.isArray(config.dpacks) ? config.dpacks : [config.dpacks]
    config.dpacks.forEach(validateDPackCfg)
  }
  if (config.proxies) {
    config.proxies = Array.isArray(config.proxies) ? config.proxies : [config.proxies]
    config.proxies.forEach(proxy => {
      check(isDomain(proxy.from), 'proxies.*.from must be a domain name, see https://docs.dpack.io/forever#proxiesfrom', proxy.from)
      check(isOrigin(proxy.to), 'proxies.*.to must be a target origin, see https://docs.dpack.io/forever#proxiesto', proxy.to)
    })
  }
  if (config.redirects) {
    config.redirects = Array.isArray(config.redirects) ? config.redirects : [config.redirects]
    config.redirects.forEach(redirect => {
      check(isDomain(redirect.from), 'redirects.*.from must be a domain name, see https://docs.dpack.io/forever#redirectsfrom', redirect.from)
      check(isOrigin(redirect.to), 'redirects.*.to must be a target origin, see https://docs.dpack.io/forever#redirectsto', redirect.to)

      // remove trailing slash
      redirect.to = redirect.to.replace(/\/$/, '')
    })
  }
}

function check (assertion, error, value, errorKey) {
  if (!assertion) {
    var err = new ConfigError(error)
    err.value = value
    if (errorKey) {
      err[errorKey] = true
    }
    throw err
  }
}

function isDWebUrl (str) {
  if (typeof str !== 'string') return false
  return /^(dweb:\/\/)?([0-9a-f]{64})\/?$/i.test(str)
}
