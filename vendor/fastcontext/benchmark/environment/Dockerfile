FROM ubuntu:24.04

WORKDIR /workspace

RUN apt-get update && apt-get install -y curl && curl -sL https://aka.ms/InstallAzureCLIDeb | bash

# Install uv and explicitly add it to the PATH
# We set the environment variable so subsequent RUN commands can find 'uv'
ENV PATH="/root/.local/bin:${PATH}"
RUN curl -LsSf https://astral.sh/uv/0.11.7/install.sh | sh || true

# Install ripgrep for searching through files
RUN curl -L -o ripgrep.tar.gz https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz \
    && tar -xzf ripgrep.tar.gz --strip-components=1 --no-same-owner -C /tmp && mv /tmp/rg /usr/bin/ && rm ripgrep.tar.gz && rm -rf /tmp/*

# Install fastcontext
# copy the wheel file to the container
COPY fastcontext-0.1.0-py3-none-any.whl /workspace/
# uv tool install installs the executable into /root/.local/bin
RUN uv tool install /workspace/fastcontext-0.1.0-py3-none-any.whl --with requests \
    && rm /workspace/fastcontext-0.1.0-py3-none-any.whl

CMD ["/bin/bash"]