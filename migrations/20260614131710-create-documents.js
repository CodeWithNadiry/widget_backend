export async function up(queryInterface, Sequelize) {
  await queryInterface.createTable('documents', {
    documentId: {
      type: Sequelize.UUID,
      defaultValue: Sequelize.UUIDV4,
      primaryKey: true,
    },

    chatbotId: {
      type: Sequelize.UUID,
      allowNull: false,
      references: {
        model: 'chatbots',
        key: 'chatbotId',
      },
      onDelete: 'CASCADE',
    },

    propertyId: {
      type: Sequelize.UUID,
      allowNull: true,      // null = applies to all properties of this chatbot
      references: {
        model: 'properties',
        key: 'propertyId',
      },
      onDelete: 'CASCADE',
    },

    fileName: {
      type: Sequelize.STRING,
      allowNull: false,
    },

    filePath: {
      type: Sequelize.TEXT,
      allowNull: false,
    },

    fileType: {
      type: Sequelize.STRING,
      allowNull: true,
    },

    status: {
      type: Sequelize.ENUM('pending', 'processing', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    },

    createdAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },

    updatedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
  });

  // RAG query always filters by chatbotId — index speeds this up
  await queryInterface.addIndex('documents', ['chatbotId'], {
    name: 'documents_chatbot_idx',
  });

  // Optional property-scoped RAG filter
  await queryInterface.addIndex('documents', ['chatbotId', 'propertyId'], {
    name: 'documents_chatbot_property_idx',
  });
}

export async function down(queryInterface) {
  await queryInterface.dropTable('documents');
}