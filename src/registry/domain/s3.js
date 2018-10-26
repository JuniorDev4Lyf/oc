/* THIS FILE IS PATCHED FOR PROXY SETTINGS */

const async = require('async');
const AWS = require('aws-sdk');
const Cache = require('nice-cache');
const format = require('stringformat');
const fs = require('fs-extra');
const nodeDir = require('node-dir');
const _ = require('lodash');

const getFileInfo = require('../../utils/get-file-info');
const getNextYear = require('../../utils/get-next-year');
const strings = require('../../resources');
const proxy = require('proxy-agent');

module.exports = function(conf) {
  const httpOptions = { timeout: conf.s3.timeout || 10000 };
  if (conf.s3.agentProxy) {
    httpOptions.agent = proxy(conf.s3.agentProxy);
  }

  const options = {
    accessKeyId: conf.s3.key,
    secretAccessKey: conf.s3.secret,
    region: conf.s3.region,
    httpOptions
  };

  if (conf.s3.overrides) {
    Object.assign(options, conf.s3.overrides);
  }
  AWS.config.update(options);

  const bucket = conf.s3.bucket;
  const cache = new Cache({
    verbose: !!conf.verbosity,
    refreshInterval: conf.refreshInterval
  });

  const getClient = () => new AWS.S3();

  const getFile = (filePath, force, callback) => {
    if (_.isFunction(force)) {
      callback = force;
      force = false;
    }

    const getFromAws = cb => {
      getClient().getObject(
        {
          Bucket: bucket,
          Key: filePath
        },
        (err, data) => {
          if (err) {
            return callback(
              err.code === 'NoSuchKey'
                ? {
                    code: strings.errors.s3.FILE_NOT_FOUND_CODE,
                    msg: format(strings.errors.s3.FILE_NOT_FOUND, filePath)
                  }
                : err
            );
          }

          cb(null, data.Body.toString());
        }
      );
    };

    if (force) {
      return getFromAws(callback);
    }

    const cached = cache.get('s3-file', filePath);

    if (cached) {
      return callback(null, cached);
    }

    getFromAws((err, result) => {
      if (err) {
        return callback(err);
      }
      cache.set('s3-file', filePath, result);
      cache.sub('s3-file', filePath, getFromAws);
      callback(null, result);
    });
  };

  const getJson = (filePath, force, callback) => {
    if (_.isFunction(force)) {
      callback = force;
      force = false;
    }

    getFile(filePath, force, (err, file) => {
      if (err) {
        return callback(err);
      }

      try {
        callback(null, JSON.parse(file));
      } catch (er) {
        return callback({
          code: strings.errors.s3.FILE_NOT_VALID_CODE,
          msg: format(strings.errors.s3.FILE_NOT_VALID, filePath)
        });
      }
    });
  };

  const getUrl = (componentName, version, fileName) =>
    `${conf.s3.path}${componentName}/${version}/${fileName}`;

  const listSubDirectories = (dir, callback) => {
    const normalisedPath =
      dir.lastIndexOf('/') === dir.length - 1 && dir.length > 0
        ? dir
        : `${dir}/`;

    getClient().listObjects(
      {
        Bucket: bucket,
        Prefix: normalisedPath,
        Delimiter: '/'
      },
      (err, data) => {
        if (err) {
          return callback(err);
        }

        if (data.CommonPrefixes.length === 0) {
          return callback({
            code: strings.errors.s3.DIR_NOT_FOUND_CODE,
            msg: format(strings.errors.s3.DIR_NOT_FOUND, dir)
          });
        }

        const result = _.map(data.CommonPrefixes, commonPrefix =>
          commonPrefix.Prefix.substr(
            normalisedPath.length,
            commonPrefix.Prefix.length - normalisedPath.length - 1
          )
        );

        callback(null, result);
      }
    );
  };

  const putDir = (dirInput, dirOutput, callback) => {
    nodeDir.paths(dirInput, (err, paths) => {
      async.each(
        paths.files,
        (file, cb) => {
          const relativeFile = file.substr(dirInput.length),
            url = (dirOutput + relativeFile).replace(/\\/g, '/');

          putFile(file, url, relativeFile === '/server.js', cb);
        },
        errors => {
          if (errors) {
            return callback(_.compact(errors));
          }

          callback(null, 'ok');
        }
      );
    });
  };

  const putFileContent = (fileContent, fileName, isPrivate, callback) => {
    const fileInfo = getFileInfo(fileName),
      obj = {
        Bucket: bucket,
        Key: fileName,
        Body: fileContent,
        ACL: isPrivate ? 'authenticated-read' : 'public-read',
        ServerSideEncryption: 'AES256',
        Expires: getNextYear()
      };

    if (fileInfo.mimeType) {
      obj.ContentType = fileInfo.mimeType;
    }

    if (fileInfo.gzip) {
      obj.ContentEncoding = 'gzip';
    }

    getClient().putObject(obj, callback);
  };

  const putFile = (filePath, fileName, isPrivate, callback) => {
    fs.readFile(filePath, (err, fileContent) => {
      if (err) {
        return callback(err);
      }
      putFileContent(fileContent, fileName, isPrivate, callback);
    });
  };

  // Cisco Starship Patch - START //
  const deleteDirectory = async dir => {
    try {
      const listParams = {
        Bucket: bucket,
        Prefix: dir
      };
      console.info(`deleteDirectory - listParams: ${JSON.stringify(listParams)}`);
      const listedObjects = await getClient()
        .listObjectsV2(listParams)
        .promise();
      console.info(`deleteDirectory - listedObjects: ${JSON.stringify(listedObjects)}`);
      if (listedObjects.Contents.length !== 0) {
        const deleteParams = {
          Bucket: bucket,
          Delete: { Objects: [] }
        };
        listedObjects.Contents.forEach(({ Key }) => {
          deleteParams.Delete.Objects.push({ Key });
        });
        let deletedObjectsInfo = await getClient()
          .deleteObjects(deleteParams)
          .promise();
        console.info(`deleteDirectory - deletedObjectsInfo: ${JSON.stringify(deletedObjectsInfo)}`);
        if (listedObjects.Contents.IsTruncated) {
          return await deleteDirectory(bucket, dir);
        }
      }
      return true;
    } catch (error) {
      return false;
    }
  };
  // Cisco Starship Patch - START //

  return {
    getFile,
    getJson,
    getUrl,
    listSubDirectories,
    maxConcurrentRequests: 20,
    putDir,
    putFile,
    putFileContent,
    deleteDirectory
  };
};
