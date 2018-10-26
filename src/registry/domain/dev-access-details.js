'use strict';

module.exports = (conf, cdn) => {
  // TODO (ashwkum4) - Add code to rotate the file log
  const filePath = () => `${conf.s3.componentsDir}/update.log`;
  const getFile = callback => cdn.getFile(filePath(), true, callback);
  const save = (data, callback) =>
    cdn.putFileContent(data, filePath(), true, callback);

  const log = (logMessage, callback) => {
    getFile((getFileErr, details) => {
      if (getFileErr) {
        callback(getFileErr);
        return;
      }
      const newFileContent = `${details}\n${logMessage}`;
      save(newFileContent, saveErr => {
        if (saveErr) {
          callback(saveErr);
          return;
        }
        callback(null, true);
      });
    });
  };

  return {
    log
  };
};
