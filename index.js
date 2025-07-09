const express    = require('express');
const multer     = require('multer');
const Docker     = require('dockerode');
const { default: getPort, portNumbers } = require('get-port');
const { v4: uuid } = require('uuid');
const path       = require('path');
const fs         = require('fs');

const upload = multer({ dest: 'uploads/' });
const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || path.join(process.env.HOME, '.colima/docker.sock')
});
const app    = express();

// se você servir uma página em public/index.html, o campo deve casar com o Multer
app.use(express.static('public'));

app.post('/deploy', upload.single('appjar'), async (req, res) => {
  try {
    const jarPath  = req.file.path;
    const deployId = uuid();
    const tag      = `test-image-${deployId}`;

    // 1) Builda a imagem que já inclui o jar
    await buildTestImage(jarPath, tag);

    // 2) Pega uma porta livre
    const hostPort = await getPort({ port: portNumbers(30000, 40000) });

    // 3) Cria e sobe o container a partir da imagem recém construída
    const container = await docker.createContainer({
      Image: tag,
      name: `test-${deployId}`,
      HostConfig: {
        PortBindings: { '9080/tcp': [{ HostPort: `${hostPort}` }] }
      },
      ExposedPorts: { '9080/tcp': {} }
    });
    await container.start();

    // 4) Agendar cleanup
    setTimeout(async () => {
      await container.stop();
      await container.remove();
      fs.unlinkSync(jarPath);
      // opcional: docker.removeImage(tag)
    }, 1000 * 60 * 30);

    res.json({
      url: `http://${req.hostname}:${hostPort}`,
      expiresInMinutes: 30
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Falha no deploy');
  }
});


const tar = require('tar-fs');

async function buildTestImage(jarPath, tag) {
  // 1) Cria um contexto de build na memória:
  //    - Dockerfile
  //    - O próprio JAR
  const dockerfile = `
FROM openliberty/open-liberty:kernel-slim-java11-openj9-ubi
COPY app.jar /config/dropins/
RUN configure.sh
`;

  // tar-fs aceita um objeto com as streams:
  const pack = tar.pack('.', {
    entries: [], // vamos registrar tudo à mão
    map: function(header) { return header; }
  });

  // No lugar de pack vindo de um diretório,
  // vamos criar um tar-stream customizado:
  const packer = require('tar-stream').pack();

  // 2) Adiciona o Dockerfile
  packer.entry({ name: 'Dockerfile' }, dockerfile);

  // 3) Adiciona o JAR (stream do arquivo)
  packer.entry({ name: 'app.jar' }, fs.readFileSync(jarPath));

  // 4) Finaliza o tar
  packer.finalize();

  // 5) Chama o docker.buildImage
  const stream = await docker.buildImage(packer, { t: tag });
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err, res) =>
      err ? reject(err) : resolve(res)
    );
  });

  // 6) Retorna a tag usada
  return tag;
}


app.listen(3000, () => console.log('Servidor rodando na porta 3000'));
