const fs = require('fs');
const path = require('path')
const url = require('url');

const jwt = require('jsonwebtoken');

const util = require('util');

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);

const sharp = require('sharp');
const fetch = require('node-fetch');

const FormData = require('form-data');
const Sequelize = require('sequelize');

const ok = require('ok.ru');
const graph = require('fbgraph');
const md5 = require('md5');

const okGet = util.promisify(ok.get);
const okRefresh = util.promisify(ok.refresh);

const graphGet = util.promisify(graph.get);
const graphPost = util.promisify(graph.post);

const Op = Sequelize.Op;

const parallel = require('promise-parallel');

const { ServerError } = require('./error');

const pathToSave = path.join(__dirname, '../../static/images');

const config = require('../config');

const appLinkStr = (id) => `
Наше приложение в Google play market:
${config.get(`AppLinks:${id}`)}`;

const dateTimeFix = function(date) {
    let cmpDate = Math.ceil( (Date.now() / 1000)) + 70;

    if(date < cmpDate ) {
        date = cmpDate;
    }

    return date + '';
}

const getTagsStr = function (images, sep = '') {

    let tags = [];

    for(let img in images) {
        tags = tags.concat(images[img].tags);
        images[img].files.forEach(img => tags = tags.concat(img.tags));
    }

    return tags.map(tag => '#' + tag).join(sep);
}

const getSigOk = function(obj, token) {
    let sec = md5(token + process.env.okprKey);
    let baseStr = '';
    for(let param of Object.keys(obj).sort()) {
        baseStr += `${param}=${obj[param]}`;
    }

    baseStr += sec;

    return md5(baseStr);
}

const vkAuthCB = function(data, Admins) {
    if(!data || !data.user_id) {
        return Promise.reject('vk data error');
    }

    delete data.access_token;

    return Admins.findOne({ where: {vkid: data.user_id} })
            .then(result => {
                if(!result) {
                    throw new Error('no admin with id');
                }
                return jwt.sign(data, process.env.secretJWT, {algorithm: 'HS256'});
            });
};

let okAppOprions = {
    applicationSecretKey: process.env.okprKey,
    applicationKey: process.env.okpbKey,
    applicationId: process.env.okAppId,
};

ok.setOptions(okAppOprions);

const categoryGetRes = function(seqRes) {
    let res = {};
    res.categories = seqRes.map(category => {
        return category.get('clientData');
    });
    res.success = true;
    return Promise.resolve(res);
}

const imgCutResolution = function (image, pathToFolder) {
    return function(metadata) {

            const mulResolution = metadata.width * metadata.height;
            const mulMin_16_9_Res = 1280 * 720;
            const mulMin_16_10_Res = 1280 * 800;
        
            if(mulResolution <= mulMin_16_9_Res || mulResolution <= mulMin_16_10_Res) {
                return writeFile(path.join(pathToFolder, '/', image.name), image.data)
            }
        
            const props_16_9 = 1.78;
            const props_16_10 = 1.6;

            let promisesArr = [writeFile(path.join(pathToFolder, '/', image.name), image.data)];
        
            if(metadata.width < metadata.height) {
                let props = parseFloat((metadata.height / metadata.width).toFixed(2));
                if(props === props_16_9) {
                    promisesArr.push(sharp(image.data).resize(720, 1280).toFile(path.join(pathToFolder, '/small/', image.name)));
                } else if(props === props_16_10) {
                    promisesArr.push(sharp(image.data).resize(800, 1280).toFile(path.join(pathToFolder, '/small/', image.name)));
                }
            } else {
                let props = parseFloat((metadata.width / metadata.height).toFixed(2));
                if(props === props_16_9) {
                    promisesArr.push(sharp(image.data).resize(1280, 720).toFile(path.join(pathToFolder, '/small/', image.name)));
                } else if(props === props_16_10) {
                    promisesArr.push(sharp(image.data).resize(1280, 800).toFile(path.join(pathToFolder, '/small/', image.name)));
                }
            }

            if(promisesArr.length == 1) {
                promisesArr.push(sharp(image.data).resize(Math.round(metadata.width / 1.5), Math.round(metadata.height / 1.5)).toFile(path.join(pathToFolder, '/small/', image.name)));
            }

            return parallel(promisesArr);
    }
};

const saveToFolderAndDbImages = function ( pathToSave, image, ImagesDb ) {

        return new Promise((res, rej) => {
            if(!image.mimetype.match(/^image\//)) throw new Error('Type must be image');
            res();
        })
        .then( () => sharp( image.data ).metadata())
        .then( imgCutResolution( image, pathToSave ) )
        .then( () => ImagesDb.build( { file: image.name, tags: image.tags, category_id: image.category } ) )
        .then( image => { return { image, success: true }} )
        .catch(error => {
            console.log('Error save images', error);
            return { error, success: false, }
        })
}

const makePost = async function(images, db, ops) {
    let imagesIdArr = [];
    for ( let image of images ) {
        let response = await saveToFolderAndDbImages( pathToSave, image, db.Images );

        console.log( 'Save date to foledr or create instance', response );

        if ( !response.success ) {
            throw new ServerError( response.error.message || 'Error save to folder or db', response.error );
        }

        try {
            let image = await response.image.save();
            imagesIdArr.push(image.dataValues.id)
        } catch ( error ) {
            console.log( 'Save date to Image db', error );
            throw new ServerError( response.error.message || 'Error save to folder or db', response.error );
        }
    }

    return db.Posts.create( { 
                publish_date: ops.publish_date, 
                text: ops.text, images: imagesIdArr, 
                appLinkId: ops.appLinkId 
            } ).then( post => post.setImages( imagesIdArr ) )
}

const getAlbumsOK = function() {
    // console.log(process.env.okRToken);
    return okRefresh(process.env.okRToken)
    .then(data => {
        ok.setAccessToken(data.access_token);
        return okGet({ method: 'photos.getAlbums', format: 'json', gid: process.env.okGid }).catch(err => err);
    })
}

const getAlbumsFB = function() {
    // console.log(process.env.fbToken);
    graph.setAccessToken(process.env.fbToken);
    return graphGet(`/${process.env.fbGid}/albums`).catch(err => err);
}


const getAlbumsVK = function() {
    let url = `https://api.vk.com/method/photos.getAlbums?&owner_id=${-process.env.vkgid}&access_token=${process.env.vktoken}&v=5.92`;
    return fetch(url).then(data => data.json()).catch(err => err);
}

const getAlbums = async function() {

    let tmp = {};

    let vkAlbums = await getAlbumsVK();

    vkAlbums.response.items.forEach(album => {
        tmp[album.title.toLowerCase()] = {
            tags: [],
            vkId: album.id
        }
    });

    // console.log(tmp);

    let okAlbums = await getAlbumsOK();
    let fbAlbums = await getAlbumsFB();

    // console.log('albums fb', fbAlbums.data);

    okAlbums.albums.forEach(album => {
        if(album.title.toLowerCase() == 'разное') {
            // console.log('In IF');
            tmp['основной'].okId = album.aid;
        } else {
            // console.log('Ok test', album.title.toLowerCase(), tmp[album.title.toLowerCase()]);
            tmp[album.title.toLowerCase()].okId = album.aid;
        }
    });

    fbAlbums.data.forEach(album => {
        // console.log('FB test', album.name.toLowerCase(), tmp[album.name.toLowerCase()]);
        tmp[album.name.toLowerCase()].fbId = album.id;
    });

    tmp['основной'].fbId = process.env.fbGid;

    // console.log(tmp);

    let toSave = [];
    for(let name in tmp) {
        toSave.push(Object.assign({name}, tmp[name]))
    }

    // console.log(toSave);

    return toSave;

};

const makeSetup = (Categories) => getAlbums()
                     .then(bToCreate => Categories.bulkCreate(bToCreate))
                     .then(() => Categories.findAll());

const createAlbumVK = function(title) {

    let urlCA = url.format({
        protocol: 'https',
        hostname: 'api.vk.com',
        pathname: '/method/photos.createAlbum',
        query: {
            group_id: process.env.vkgid,
            title,

            access_token: process.env.vktoken,
            v: 5.92
        }
    });

    return fetch(urlCA)
            .then(data => data.json())
            .then(data => {
                return {success: true, data}
            }).catch(err => {
                return {success: false, err}
            });
}

const createAlbumFB = function(name) {

    graph.setAccessToken(process.env.fbToken);

    return graphPost(`/${process.env.fbGid}/albums`, {name})
           .then(data => {
            return {success: true, data};
           })
           .catch(err => {
                return {success: false, err};
           });
}

const createAlbumOK = function(title) {

    return okRefresh(process.env.okRToken)
    .then(data => ok.setAccessToken(data.access_token))
    .then(() => {

        let urlPost = url.format({
            protocol: 'https',
            hostname: 'api.ok.ru',
            pathname: 'fb.do',
            query: {
                application_key: process.env.okpbKey,
                format: 'json',
                method: 'photos.createAlbum',
                gid: process.env.okGid,
                title,
                sig: getSigOk({application_key: process.env.okpbKey, format: 'json', method: 'photos.createAlbum', gid: process.env.okGid, title}, ok.getAccessToken().trim()),
                access_token: ok.getAccessToken().trim()
            }
        });

        return fetch(urlPost)
                .then(data => data.json())
                .then(data => {
                    return {success: true, data}
                }).catch(err => {
                    return {success: false, err}
                });
    })
}

const createAlbum = async function(name, tags, Categories) {

    let check = await Categories.findAll({where: {name}}).then(data => {
        return {success: !!data};
    }).catch(err => {
        console.log('Error add album in db', err);
        return {success: false, err};
    });

    if(!check.success) {
        if(!check.err) {
            check.message = 'Такая категория уже существует';
        }
        throw check;
    };

    let [vk, fb, ok] = await parallel([createAlbumVK(name),
                                       createAlbumFB(name),
                                       createAlbumOK(name)
                                     ]);

    console.log('Data create social', vk, fb, ok);

    if(!vk.success || !fb.success || !ok.success) {
        throw {vk, fb, ok};
    }

    return Categories.create({name, tags, vkId: vk.data.response.id,
                                          fbId: fb.data.id,
                                          okId: ok.data
                                        });

}

const postOK = async function(images, ops) {
    // console.log('OK start', images);

    let allImages = [];

    for(let img in images) {
        images[img].files.forEach(img => allImages.push(img));
    }

    let text = getTagsStr(images, ' ');

    return okRefresh(process.env.okRToken)
    .then(data => ok.setAccessToken(data.access_token))
    .then(() => okGet({method: 'photosV2.getUploadUrl', count: allImages.length, gid: process.env.okGid}))
    .then(data => {
        // console.log(data);

        let form = new FormData();

        allImages.forEach((img, i) => {
            form.append(`pic${i+1}`, img.data, {
                filename: img.name,
                contentType: img.mimetype
            });
        })

        return fetch(data.upload_url, {
                     method: 'post',
                     body: form,
                     headers: form.getHeaders()
                })
    })
    .then(data => data.json())
    .then(data => {
        // console.log('\n\n****Uploaded****\n\n', data.photos);

        let at = {
            "media": [
              {
                "type": "photo",
                "list": []
              }
            ],
            "publishAtMs": (+ops.publish_date * 1000) + ''
        };

        text = `${ops.text}
${text}`;
        text += appLinkStr(ops.appLinkId);

        // if((text.length > 1) && text) {
            at.media.push({
                "type": "text",
                "text": text
            })
        // }

        for(let id in data.photos) {
            // console.log('\n\nID:', id,  '\nToken:', data.photos[id].token);
            at.media[0].list.push({id: data.photos[id].token});
        }


        let urlPost = url.format({
            protocol: 'https',
            hostname: 'api.ok.ru',
            pathname: 'fb.do',
            query: {
                application_key: process.env.okpbKey,
                format: 'json',
                method: 'mediatopic.post',
                type: 'GROUP_THEME',
                gid: process.env.okGid,
                attachment: JSON.stringify(at),
                sig: getSigOk({application_key: process.env.okpbKey, format: 'json', method: 'mediatopic.post', type: 'GROUP_THEME', gid: process.env.okGid, attachment: JSON.stringify(at)}, ok.getAccessToken().trim()),
                access_token: ok.getAccessToken().trim()
            }
        });

        return fetch(urlPost)

    })
    .then(data => data.json())
    .then(post => {
        console.log('End post OK', post);
        if ( post instanceof Object ) {
            throw post;
        }
        return { res: post, success: true };
    })
    .catch(error => {
        console.log('Promis error OK', error);
        return { error, success: false };
    });
}

const savePhotoVK = function(imgGroup) {

    let form = new FormData();

    imgGroup.files.forEach((img, i) => {
        form.append(`file${i+1}`, img.data, {
            filename: img.name,
            contentType: img.mimetype
        });
    }) 

    let getServer = `https://api.vk.com/method/photos.getUploadServer?&album_id=${imgGroup.vkAid}&group_id=${process.env.vkgid}&access_token=${process.env.vktoken}&v=5.62`;
    return fetch(getServer)
            .then(data => data.json())
            .then(data => data.response.upload_url)
            .then(url => fetch(url, {
                method: 'POST',
                body:    form,
                headers: form.getHeaders(),
            }))
            .then(data => data.json())
            .then(data => {
                // console.log('Photos list', data);
                let url = `https://api.vk.com/method/photos.save?album_id=${data.aid}&group_id=${data.gid}&server=${data.server}&hash=${data.hash}&photos_list=${data.photos_list}&access_token=${process.env.vktoken}&v=5.62`
                return fetch(url);
            })
            .then(data => data.json())
            .then(data => {
                // console.log(data);
                return data.response.map(photo => `photo${photo.owner_id}_${photo.id}`).join(',');
            })
            .catch(err => err)
}


const postVK = async function(images, ops) {

    // console.log('VK start', images);

    let prPhotos = [];

    for(let img in images) {
        prPhotos.push(savePhotoVK(images[img]));
    }

    let attachments = await parallel(prPhotos);
    console.log('VK attachments', attachments);
    attachments.push(config.get(`AppLinks:${ops.appLinkId}`));
    attachments  = attachments.join(',');


    // console.log('Tags************\n\n', tags);
    let message = getTagsStr(images);

    message = `${ops.text}
    ${message}`;

    let postUrl = url.format({
        protocol: 'https',
        hostname: 'api.vk.com',
        pathname: '/method/wall.post',
        query: {
            message,
            attachments,
            owner_id: -process.env.vkgid,
            access_token: process.env.vktoken,
            from_group: 1,
            publish_date: ops.publish_date,
            v: 5.67
        }
    })
    return fetch(postUrl)
    .then(data => data.json())
    .then(post => {
        console.log('End post VK', post);
        if ( !post.response || !post.response.post_id ) {
            throw post;
        }
        return { res: post, success: true };
    })
    .catch(error => {
        console.log('Promis error VK', error);
        return { error, success: false, };
    });
}

const postFBAlbum = async function(images, ops) {

    let prArr = [];

    graph.setAccessToken(process.env.fbToken);

    console.log('FB start', images);

    for(let categ in images) {

        for(let img of images[categ].files) {

            //https://www.psychologistworld.com/images/articles/a/575x360-v-dpc-71331987.jpg
            //url: `${ops.url}${img.name}`

            let caption = images[categ].tags.concat(img.tags).map(tag => '#' + tag).join(' ');

            console.log('Test img FB', `${ops.url}${img.name}`);
            
            let pr = parallel([
                graphPost(`/${process.env.fbGid}/photos`, {url: `${ops.url}${img.name}`, caption, published: false}).catch(err => err),
                graphPost(`/${images[categ].fbAid}/photos`, {url: `${ops.url}${img.name}`, caption}).catch(err => err)
            ]).then(([wall, album]) => {

                if(!wall.id || !album.id) {
                    throw {wall, album};
                }

                img.fbPostId = wall.id;
                console.log('FB data post album', wall, album);
                return {wall, album, success: true};

            }).catch(error => {
                console.log('FB promise save error', error);
                return {error, success: false};
            });

            prArr.push(pr);

        }
    }

    return parallel(prArr)
           .then(results => {
                if(results.every(res => res.success)) {
                    return {results, success: true};
                }

                return {results, success: false};
           })     
}

const postFBWall = async function(records) {

    let body = {};
    body.message = '';

    let i = 0;

    for(let rec of records) {
        body.message += rec.get('text') + '\n';
        rec = rec.get('jsonData');
        body.message += getTagsStr(rec, ' ') + ' ';
        for(let categ in rec) {
            for(let img of rec[categ].files) {
                body[`attached_media[${i++}]`] = {"media_fbid": img.fbPostId};
            }
        }
    }

    // body.message += appLinkStr();

    console.log('FB Post BODY', body);

    return graphPost(`/${process.env.fbGid}/feed`, body)
    .catch(err => err);
}

const postOnTime = function(Posts, pathToFolder) {
    
    let flag = true;

    setInterval(async () => {

        if(flag && process.env.isInit) {

            let time = Math.ceil(Date.now() / 1000);

            let data = await Posts.findAll({
                where: {
                    pTime: {
                        [Op.lte]: time
                    }
                }
            }).catch(err => {
                flag = true;
                console.log(err);
            })

            if(data && data.length) {
                flag = false;//изменил!!

                try {
                    postTelegram(data, pathToFolder);
                    let results = await parallel([
                        postFBWall(data),
                        postOKAlbum(data, pathToFolder)
                    ]);
                    console.log(results);
                } catch(err) {
                    console.log('Post on time error', err);
                }
            }

            let resDel = await Posts.destroy({
                where: {
                    pTime: {
                        [Op.lte]: time
                    }
                }
            })
            .catch(err => err);

            flag = true;

            console.log(resDel);
        }

    }, 1000 * 15);
}

const postTelegram = async function(records, pathToFolder) {

    // console.log('Pre data', records);

    for(let rec of records) {
        rec = rec.get('jsonData')
        for(let categ in rec) {
            for(let img of rec[categ].files) {

                try {

                    let file = await readFile(path.join(pathToFolder, '/', img.name));

                    let caption = rec[categ].tags.concat(img.tags).map(tag => '#' + tag).join(' ');

                    let formPhoto = new FormData();

                    formPhoto.append('chat_id', process.env.telGroup);
                    formPhoto.append('caption', caption);
                    formPhoto.append('photo', file, {
                        filename: img.name,
                        contentType: img.mimetype
                    });

                    let formDoc = new FormData();
                    
                    formDoc.append('chat_id', process.env.telGroup);
                    formDoc.append('caption', caption);
                    formDoc.append('document', file, {
                        filename: img.name,
                        contentType: img.mimetype
                    });
                    formDoc.append('reply_markup', JSON.stringify({
                        inline_keyboard: [[{text: 'Наше приложение', url: process.env.appUrl}]]
                    }))

                    //process.env.appUrl

                    let resPhoto = await fetch(`https://api.telegram.org/bot${process.env.telToken}/sendPhoto`, {
                        method: "POST",
                        body: formPhoto,
                        headers: formPhoto.getHeaders(),
                    })
                    .then(res => res.json())
                    .catch(err => {
                        console.log('Error photo', err);
                        return err;
                    });

                    console.log('Telegram photo', resPhoto);

                    let resDoc = await fetch(`https://api.telegram.org/bot${process.env.telToken}/sendDocument`, {
                        method: "POST",
                        body: formDoc,
                        headers: formDoc.getHeaders(),
                    })
                    .then(res => res.json())
                    .catch(err => {
                        console.log('Error doc', err);
                        return err;
                    });

                    console.log('Telegram photo', resDoc);

                } catch (err) {
                    console.log(err);
                    continue;
                }

            }
        }
    }
}

const postOKAlbum = async function(records, pathToFolder) {
    // console.log('Data OK Albums', records);

    for(let rec of records) {
        rec = rec.get('jsonData')
        for(let categ in rec) {

            await okRefresh(process.env.okRToken)
            .then(data => {
                // console.log('Refresh', data);
                ok.setAccessToken(data.access_token);
            }).then(() => okGet({method: 'photosV2.getUploadUrl', count: rec[categ].files.length, gid: process.env.okGid, aid: rec[categ].okAid }))
            .then(async data => {
                // console.log(data);

                let form = new FormData();
                let i = 1;

                for(let img of rec[categ].files) {

                    let file = null
                    try {
                        file = await readFile(path.join(pathToFolder, '/', img.name));
                        // console.log('File', file);
                    } catch (err) {
                        // console.log(err);
                        continue;
                    }
        
                    let fName = `file${i++}`
                    form.append(fName, file, {
                        filename: img.name,
                        contentType: img.mimetype
                    });
                }

                return fetch(data.upload_url, {
                    method: 'post',
                    body: form,
                    headers: form.getHeaders()
               });
            }).then(data => data.json())
            .then(async data => {
                
                let arrRes = [];

                for(let id in data.photos) {
                    // console.log('\n\nID:', id,  '\nToken:', data.photos[id].token)
                    let urlSave = url.format({
                        protocol: 'https',
                        hostname: 'api.ok.ru',
                        pathname: 'fb.do',
                        query: {
                            application_key: process.env.okpbKey,
                            format: 'json',
                            method: 'photosV2.commit',
                            photo_id: id,
                            token: data.photos[id].token,
                            sig: getSigOk({application_key: process.env.okpbKey, format: 'json', method: 'photosV2.commit', photo_id: id, token: data.photos[id].token}, ok.getAccessToken().trim()),
                            access_token: ok.getAccessToken().trim()
                        }
                    });
        
        
                    let reult = await fetch(urlSave).then(data => data.json()).catch(err => err);
        
                    arrRes.push(reult);
                }
        
                return arrRes;
            })
            .catch(err => err);

        }
    }
}

const postToDB = async function(images, Post, ops) {
    console.log('\n\n*****POST TO DB *****\n\n', images, JSON.stringify(images));
    return Post.create({pTime: ops.publish_date, jsonData: images, text: ops.text})
    .then(res => {
        console.log(res.get('jsonData'));
        return {res, success: true}
    })
    .catch(error => {
        console.log('Promis error OK', error);
        return {error, success: false};
    });
}

const saveImages = async function(pathToFolder, imagesArr, db, ops) {

    let results = Object.create(null);

    results.save = [];

    // console.log(imagesArr);
    let filesSaved = [];
    for(let image of imagesArr) {
        try {
            let res = await makePromiseToSave(pathToFolder, image, db.Images);
            if(res.success) {
                res.file = image.name;
                filesSaved.push(image);
                results.save.push(res);
            } else {
                res.message = 'Проблема сохранении изображения'
                throw res;
            }
        } catch (err) {
            console.log('Error Save Db (catch(err))', err);
            throw err;
        }
    }

    // console.log(filesSaved);
    let categGroup = {};
    filesSaved.forEach(img => {

        img.toJSON = function() {
            return {
                name: this.name,
                mimetype: this.mimetype,
                tags: this.tags,
                fbPostId: this.fbPostId
            }
        }

        if(!categGroup[img.category]) {
            categGroup[img.category] = {
                files: [img]
            }
            categGroup[img.category] = Object.assign(categGroup[img.category], ops.categOps[img.category])
        } else {
            categGroup[img.category].files.push(img);
        }
    });

    // console.log('*********\nCateg Ops', categGroup, '\n********');

    ops.publish_date = dateTimeFix(ops.publish_date);

    try {

        let resultsPr = await parallel([
            postFBAlbum(categGroup, ops),
            postVK(categGroup, ops), 
            postOK(categGroup, ops)
        ]);

        console.log('Paraller results', resultsPr);

        results.fb = resultsPr[0];
        results.vk = resultsPr[1];
        results.ok = resultsPr[2];

        results.social = resultsPr.every(res => res.success);

    } catch(err) {
        console.log('Paraller (catch(err))', err);
        throw err;
    }

    try {

        results.db = await postToDB(categGroup, db.Posts, ops);
        console.log('Post ind DB res', results.db);

        results.db = {success: true};

    } catch (err) {
        console.log('Error post OK Teleg FB In DB (catch(err))', err);
        throw err;
    }

    return results;
}

exports.makePost = makePost;
exports.vkAuthCB = vkAuthCB;
exports.categoryGetRes = categoryGetRes;
exports.saveImages = saveImages;
exports.createAlbum = createAlbum;
exports.postOnTime = postOnTime;
exports.getAlbums = getAlbums;
exports.makeSetup = makeSetup;