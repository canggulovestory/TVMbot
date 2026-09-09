'use strict';
// This is the trusted broker, never an imported Hermes/model tool.
const path=require('node:path'),fs=require('node:fs'),http=require('node:http');
const root=path.resolve(__dirname,'..');
require('dotenv').config({path:path.join(root,'.env'),quiet:true});
const configFile='/etc/zuzu-runtime/operations-broker.json';
if(fs.statSync(configFile).mode&0o077)throw Error('Broker config must be private');
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const tasks=require('../notion'),villas=require('../villa-data');
tasks.init();villas.init(path.resolve(process.env.DATA_DIR||path.join(root,'data')));
const handler=require('../operations-connector').createOperationsHandler({...config,tasks,villas,journalDir:'/var/lib/zuzu-operations/journal'});
const server=http.createServer(handler);
server.requestTimeout=20000;server.headersTimeout=15000;
server.listen(18643,'127.0.0.1',()=>console.log('Protected task/villa broker listening on loopback'));
