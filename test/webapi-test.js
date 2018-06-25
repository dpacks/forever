const test = require('ava')
const {ForeverConfig} = require('../lib/config')
const {createServer} = require('./util')

test('login fails on wrong username or password', async t => {
  var res
  var server = createServer(`
webapi:
  username: bob
  password: hunter2
`)

  // wrong password fails
  res = await server.req.post({
    uri: '/v1/accounts/login',
    json: {
      username: 'bob',
      password: 'hunter3'
    }
  })
  t.deepEqual(res.statusCode, 403)

  // wrong username fails
  res = await server.req.post({
    uri: '/v1/accounts/login',
    json: {
      username: 'alice',
      password: 'hunter2'
    }
  })
  t.deepEqual(res.statusCode, 403)

  server.close()
})

test('can get account info only if logged in', async t => {
  var res
  var auth
  var server = createServer(`
domain: test.com
webapi:
  username: bob
  password: hunter2
dpacks:
  - url: dweb://1f968afe867f06b0d344c11efc23591c7f8c5fb3b4ac938d6000f330f6ee2a03/
    name: mysite
`)

  // cant get account info if not logged in
  res = await server.req.get({
    uri: '/v1/accounts/account'
  })
  t.deepEqual(res.statusCode, 401)

  // cant list dPacks if not logged in
  res = await server.req.get({
    uri: '/v1/dpacks'
  })
  t.deepEqual(res.statusCode, 401)

  // login
  res = await server.req.post({
    uri: '/v1/accounts/login',
    json: {
      username: 'bob',
      password: 'hunter2'
    }
  })
  t.deepEqual(res.statusCode, 200)
  auth = {bearer: res.body.sessionToken}

  // can get account info
  res = await server.req.get({
    uri: '/v1/accounts/account',
    auth,
    json: true
  })
  t.deepEqual(res.statusCode, 200)
  t.deepEqual(res.body.username, 'bob')

  // can list dPacks
  res = await server.req.get({
    uri: '/v1/dpacks',
    auth,
    json: true
  })
  t.deepEqual(res.statusCode, 200)
  t.deepEqual(res.body.items, [
    {
      url: 'dweb://1f968afe867f06b0d344c11efc23591c7f8c5fb3b4ac938d6000f330f6ee2a03/',
      name: 'mysite',
      additionalUrls: [
        'dweb://mysite.test.com'
      ]
    }
  ])

  // logout
  res = await server.req.post({
    uri: '/v1/accounts/logout',
    auth
  })
  t.deepEqual(res.statusCode, 200)

  // cant get account info on ended session
  res = await server.req.get({
    uri: '/v1/accounts/account',
    auth
  })
  t.deepEqual(res.statusCode, 401)

  server.close()
})

test('add & remove dPacks', async t => {
  var res
  var auth
  var syncPromise
  var server = createServer(`
domain: test.com
webapi:
  username: bob
  password: hunter2
dpacks:
  - url: dweb://1f968afe867f06b0d344c11efc23591c7f8c5fb3b4ac938d6000f330f6ee2a03/
    name: mysite
`)

  // login
  res = await server.req.post({
    uri: '/v1/accounts/login',
    json: {
      username: 'bob',
      password: 'hunter2'
    }
  })
  t.deepEqual(res.statusCode, 200)
  auth = {bearer: res.body.sessionToken}

  // add dPacks
  syncPromise = new Promise(resolve => server.config.events.once('read-config', resolve))
  res = await server.req.post({
    uri: '/v1/dpacks/add',
    json: {
      url: 'dweb://868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f/',
      name: 'othersite',
      domains: ['othersite.com']
    },
    auth
  })
  t.deepEqual(res.statusCode, 200)

  // wait for sync
  await syncPromise

  // get dPack (verify)
  res = await server.req.get({
    uri: '/v1/dpacks/item/868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f',
    auth,
    json: true
  })
  t.deepEqual(res.statusCode, 200)
  t.deepEqual(res.body, {
    url: 'dweb://868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f/',
    name: 'othersite',
    additionalUrls: [
      'dweb://othersite.test.com',
      'dweb://othersite.com'
    ]
  })

  // check config
  t.deepEqual(
    (new ForeverConfig(server.config.configPath)).canonical.dpacks,
    [
      {
        url: 'dweb://1f968afe867f06b0d344c11efc23591c7f8c5fb3b4ac938d6000f330f6ee2a03/',
        name: 'mysite',
        otherDomains: undefined
      },
      {
        url: 'dweb://868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f/',
        name: 'othersite',
        otherDomains: [
          'othersite.com'
        ]
      }
    ]
  )

  // wait 500ms for config-update-watch to reset
  await new Promise(resolve => setTimeout(resolve, 500))

  // partially update dPack
  syncPromise = new Promise(resolve => server.config.events.once('read-config', resolve))
  res = await server.req.post({
    uri: '/v1/dpacks/item/868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f',
    json: {
      domains: ['othersite.com', 'other-site.com']
    },
    auth
  })
  t.deepEqual(res.statusCode, 200)

  // wait for sync
  console.log('waiting for sync')
  await syncPromise

  // get dPack (verify)
  res = await server.req.get({
    uri: '/v1/dpacks/item/868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f',
    auth,
    json: true
  })
  t.deepEqual(res.statusCode, 200)
  t.deepEqual(res.body, {
    url: 'dweb://868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f/',
    name: 'othersite',
    additionalUrls: [
      'dweb://othersite.test.com',
      'dweb://othersite.com',
      'dweb://other-site.com'
    ]
  })

  // check config
  t.deepEqual(
    (new ForeverConfig(server.config.configPath)).canonical.dpacks,
    [
      {
        url: 'dweb://1f968afe867f06b0d344c11efc23591c7f8c5fb3b4ac938d6000f330f6ee2a03/',
        name: 'mysite',
        otherDomains: undefined
      },
      {
        url: 'dweb://868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f/',
        name: 'othersite',
        otherDomains: [
          'othersite.com',
          'other-site.com'
        ]
      }
    ]
  )

  // list dPacks
  res = await server.req.get({
    uri: '/v1/dpacks',
    auth,
    json: true
  })
  t.deepEqual(res.statusCode, 200)
  t.deepEqual(res.body.items, [
    {
      url: 'dweb://1f968afe867f06b0d344c11efc23591c7f8c5fb3b4ac938d6000f330f6ee2a03/',
      name: 'mysite',
      additionalUrls: [
        'dweb://mysite.test.com'
      ]
    },
    {
      url: 'dweb://868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f/',
      name: 'othersite',
      additionalUrls: [
        'dweb://othersite.test.com',
        'dweb://othersite.com',
        'dweb://other-site.com'
      ]
    }
  ])

  // wait 500ms for config-update-watch to reset
  await new Promise(resolve => setTimeout(resolve, 500))

  // remove dPack
  syncPromise = new Promise(resolve => server.config.events.once('read-config', resolve))
  res = await server.req.post({
    uri: '/v1/dpacks/remove',
    json: {
      url: '868d6000f330f6967f06b3ee2a03811efc23591afe0d344cc7f8c5fb3b4ac91f'
    },
    auth
  })
  t.deepEqual(res.statusCode, 200)

  // wait for sync
  await syncPromise

  // check config
  t.deepEqual(
    (new ForeverConfig(server.config.configPath)).canonical.dpacks,
    [
      {
        url: 'dweb://1f968afe867f06b0d344c11efc23591c7f8c5fb3b4ac938d6000f330f6ee2a03/',
        name: 'mysite',
        otherDomains: undefined
      }
    ]
  )

  // list dPacks
  res = await server.req.get({
    uri: '/v1/dpacks',
    auth,
    json: true
  })
  t.deepEqual(res.statusCode, 200)
  t.deepEqual(res.body.items, [
    {
      url: 'dweb://1f968afe867f06b0d344c11efc23591c7f8c5fb3b4ac938d6000f330f6ee2a03/',
      name: 'mysite',
      additionalUrls: [
        'dweb://mysite.test.com'
      ]
    }
  ])

  server.close()
})
