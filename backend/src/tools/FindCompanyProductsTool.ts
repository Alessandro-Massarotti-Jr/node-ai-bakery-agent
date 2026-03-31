import { Tool } from ".";
import { IProductsRepository } from "../repositories/productsRepository/interfaces/IProductsRepository";
import { IEmbeddingProvider } from "../providers/EmbeddingProvider/interfaces/IEmbeddingProvider";

export class FindCompanyProductsTool extends Tool {
  private repository: IProductsRepository;
  private embedding: IEmbeddingProvider;

  private constructor(
    repository: IProductsRepository,
    embedding: IEmbeddingProvider,
  ) {
    super({
      name: "findCompanyProducts",
      description:
        "Ferramenta para buscar produtos da padaria com base em uma descrição ou nome. Use esta ferramenta para responder perguntas dos clientes sobre os produtos disponíveis na padaria. O resultado é uma lista de produtos relevantes com base na consulta do cliente.",
    });

    this.repository = repository;
    this.embedding = embedding;

    this.addParameter({
      name: "query",
      type: "string",
      description: "Descrição ou nome do produto a ser buscado no catálogo",
      required: true,
    });
  }

  public static create(
    repository: IProductsRepository,
    embedding: IEmbeddingProvider,
  ): FindCompanyProductsTool {
    return new FindCompanyProductsTool(repository, embedding);
  }

  public async execute({ query }: { query: string }) {
    const vector = await this.embedding.embed({ text: query });
    return this.repository.search({ vector });
  }
}
