#!/usr/bin/env node
const os = require('os')
const path = require('path')
const {ForeverConfig} = require('./lib/config')
const server = require('./lib/server')

const defaultConfigPath = process.env.DPACK_FOREVER_CONFIG || path.join(os.homedir(), '.dforever.yml')

const argv = require('yargs')
  .usage('dforever - Start a dPack Forever server')
  .option('config', {
    describe: 'Path to the config file. If no path is given, the path to the config is looked up in the DPACK_FOREVER_CONFIG environment variable. If this is not set, the config will be read from the default path ~/.forever.yml.',
    default: defaultConfigPath
  })
  .argv

// read config and start the server
var config = new ForeverConfig(argv.config)
server.start(config)
