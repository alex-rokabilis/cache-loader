/* eslint-disable
  import/order
*/
const fs = require('fs');
const path = require('path');
const async = require('neo-async');
const crypto = require('crypto');
const mkdirp = require('mkdirp');

const { getOptions } = require('loader-utils');
const validateOptions = require('schema-utils');

const pkg = require('../package.json');

const env = process.env.NODE_ENV || 'development';

const schema = require('./options.json');

const defaults = {
  cacheDirectory: path.resolve('.cache-loader'),
  cacheIdentifier: `cache-loader:${pkg.version} ${env}`,
  cacheKey,
  read,
  write,
  debug: false,
};

function checksumFile(hashName, path) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(hashName);
    const stream = fs.createReadStream(path);
    stream.on('error', err => reject(err));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function loader(...args) {
  const options = Object.assign({}, defaults, getOptions(this));

  validateOptions(schema, options, 'Cache Loader');

  const { write: writeFn } = options;

  const callback = this.async();
  const { data } = this;
  const dependencies = this.getDependencies().concat(this.loaders.map(l => l.path));
  const contextDependencies = this.getContextDependencies();

  // Should the file get cached?
  const cache = true;

  const toDepDetails = (dep, mapCallback) => {
    checksumFile('md5', dep)
      .then((md5checksum) => {
        mapCallback(null, {
          path: dep,
          md5checksum,
        });
      })
      .catch(err => mapCallback(err));

    // fs.stat(dep, (err, stats) => {
    //   if (err) {
    //     mapCallback(err);
    //     return;
    //   }

    //   // const mtime = stats.mtime.getTime();

    //   // if (mtime / 1000 >= Math.floor(data.startTime / 1000)) {
    //   //   // Don't trust mtime.
    //   //   // File was changed while compiling
    //   //   // or it could be an inaccurate filesystem.
    //   //   cache = false;
    //   // }

    //   mapCallback(null, {
    //     path: dep,
    //     size: stats.size,
    //   });
    // });
  };

  async.parallel([
    cb => async.mapLimit(dependencies, 20, toDepDetails, cb),
    cb => async.mapLimit(contextDependencies, 20, toDepDetails, cb),
  ], (err, taskResults) => {
    if (err) {
      callback(null, ...args);
      return;
    }
    if (!cache) {
      callback(null, ...args);
      return;
    }
    const [deps, contextDeps] = taskResults;
    writeFn(data.cacheKey, {
      remainingRequest: data.remainingRequest,
      dependencies: deps,
      contextDependencies: contextDeps,
      result: args,
    }, () => {
      // ignore errors here
      callback(null, ...args);
    });
  });
}

function pitch(remainingRequest, prevRequest, dataInput) {
  const options = Object.assign({}, defaults, getOptions(this));

  validateOptions(schema, options, 'Cache Loader (Pitch)');

  const { read: readFn, cacheKey: cacheKeyFn } = options;

  const callback = this.async();
  const data = dataInput;

  data.remainingRequest = remainingRequest;
  data.cacheKey = cacheKeyFn(options, remainingRequest);
  readFn(data.cacheKey, (readErr, cacheData) => {
    if (readErr) {
      callback();
      return;
    }
    if (cacheData.remainingRequest !== remainingRequest) {
      // in case of a hash conflict
      callback();
      return;
    }
    async.each(cacheData.dependencies.concat(cacheData.contextDependencies), (dep, eachCallback) => {
      checksumFile('md5', dep.path)
        .then((md5checksum) => {
          if (md5checksum !== dep.md5checksum) {
            // eslint-disable-next-line
            options.debug && console.log(`${dep.path} --- CACHE MISS`);
            eachCallback(true);
            return;
          }
          // eslint-disable-next-line
          options.debug && console.log(`${dep.path} --- CACHE HIT`);
          eachCallback();
        })
        .catch(err => eachCallback(err));
    }, (err) => {
      if (err) {
        data.startTime = Date.now();
        callback();
        return;
      }
      cacheData.dependencies.forEach(dep => this.addDependency(dep.path));
      cacheData.contextDependencies.forEach(dep => this.addContextDependency(dep.path));
      callback(null, ...cacheData.result);
    });
  });
}

function digest(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

const directories = new Set();

function write(key, data, callback) {
  const dirname = path.dirname(key);
  const content = JSON.stringify(data);

  if (directories.has(dirname)) {
    // for performance skip creating directory
    fs.writeFile(key, content, 'utf-8', callback);
  } else {
    mkdirp(dirname, (mkdirErr) => {
      if (mkdirErr) {
        callback(mkdirErr);
        return;
      }

      directories.add(dirname);

      fs.writeFile(key, content, 'utf-8', callback);
    });
  }
}

function read(key, callback) {
  fs.readFile(key, 'utf-8', (err, content) => {
    if (err) {
      callback(err);
      return;
    }

    try {
      const data = JSON.parse(content);
      callback(null, data);
    } catch (e) {
      callback(e);
    }
  });
}

function cacheKey(options, request) {
  const { cacheIdentifier, cacheDirectory } = options;
  const hash = digest(`${cacheIdentifier}\n${request}`);

  return path.join(cacheDirectory, `${hash}.json`);
}

export { loader as default, pitch };
